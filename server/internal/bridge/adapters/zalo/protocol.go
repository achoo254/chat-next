package zalo

import (
	"bytes"
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
)

// protocolVersion is the stdio protocol of the sidecar this adapter speaks
// (src/entry.mjs of the sidecar). A bundle that announces another version is
// refused instead of half understood.
const protocolVersion = 2

// maxLineBytes bounds one line of the sidecar's stdout. A QR image is about
// 10 KiB and a text message far less; a longer line is a broken sidecar.
const maxLineBytes = 1 << 20

// Commands the sidecar reads on stdin.
const (
	cmdLoginQR      = "login_qr"
	cmdLoginSession = "login_session"
)

// Events the sidecar writes on stdout.
const (
	evReady      = "ready"
	evQR         = "qr"
	evQRScanned  = "qr_scanned"
	evQRExpired  = "qr_expired"
	evQRDeclined = "qr_declined"
	evLoggedIn   = "logged_in"
	evAccount    = "account"
	evMessage    = "message"
	evOther      = "event"
	evListener   = "listener"
	evError      = "error"
)

// command is one line written to the sidecar.
type command struct {
	Cmd     string          `json:"cmd"`
	Session json.RawMessage `json:"session,omitempty"`
}

// wireEvent is one line read from the sidecar. Every event shares this shape;
// a field an event does not carry stays at its zero value. Payloads the
// adapter does not read stay raw and are never logged.
type wireEvent struct {
	Ev       string          `json:"ev"`
	Protocol int             `json:"protocol"`
	Image    string          `json:"image"`
	Session  json.RawMessage `json:"session"`
	UID      looseString     `json:"uid"`
	// message
	Thread   string          `json:"thread"`
	Self     bool            `json:"self"`
	MsgType  looseString     `json:"msgType"`
	Content  json.RawMessage `json:"content"`
	MsgID    looseString     `json:"msgId"`
	CliMsgID looseString     `json:"cliMsgId"`
	UIDFrom  looseString     `json:"uidFrom"`
	IDTo     looseString     `json:"idTo"`
	DName    string          `json:"dName"`
	TS       looseString     `json:"ts"`
	// event, listener, error
	Name    string          `json:"name"`
	Payload json.RawMessage `json:"payload"`
	State   string          `json:"state"`
	Code    looseString     `json:"code"`
	Message string          `json:"message"`
}

// decodeEvent parses one stdout line. A line that is not a JSON object with an
// "ev" name is an error; the caller drops it without logging its content.
func decodeEvent(line []byte) (wireEvent, error) {
	var ev wireEvent
	if err := json.Unmarshal(line, &ev); err != nil {
		return wireEvent{}, errors.New("zalo: sidecar line is not an event")
	}
	if ev.Ev == "" {
		return wireEvent{}, errors.New("zalo: sidecar event without a name")
	}
	return ev, nil
}

// looseString takes a JSON string, number or null: Zalo sends ids and times
// either way depending on the path that produced them.
type looseString string

// UnmarshalJSON implements json.Unmarshaler.
func (s *looseString) UnmarshalJSON(data []byte) error {
	data = bytes.TrimSpace(data)
	switch {
	case bytes.Equal(data, []byte("null")):
		*s = ""
	case len(data) > 0 && data[0] == '"':
		var v string
		if err := json.Unmarshal(data, &v); err != nil {
			return err
		}
		*s = looseString(v)
	default:
		var n json.Number
		if err := json.Unmarshal(data, &n); err != nil {
			return errors.New("zalo: expected a string or a number")
		}
		*s = looseString(n.String())
	}
	return nil
}

// session is what a QR login yields and every later start needs: the cookie
// jar, the device id and the browser it claimed to be. The engine seals it.
type session struct {
	Cookie    json.RawMessage `json:"cookie"`
	IMEI      string          `json:"imei"`
	UserAgent string          `json:"userAgent"`
}

// errBadSession never carries the session itself.
var errBadSession = errors.New("zalo: stored session is incomplete")

// parseSession checks a session from the sidecar or the engine and returns it
// in canonical form (only the three fields, nothing else the sidecar added).
func parseSession(raw []byte) ([]byte, error) {
	var s session
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, errBadSession
	}
	cookie := bytes.TrimSpace(s.Cookie)
	if len(cookie) == 0 || bytes.Equal(cookie, []byte("null")) || s.IMEI == "" || s.UserAgent == "" {
		return nil, errBadSession
	}
	out, err := json.Marshal(s)
	if err != nil {
		return nil, errBadSession
	}
	return out, nil
}

// zaloID matches the ids Zalo gives users and messages (decimal digits on
// the account observed; any short plain token is taken).
var zaloID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// codeWord is what a code from the sidecar may look like to be printed.
var codeWord = regexp.MustCompile(`^[A-Za-z0-9_]{1,40}$`)

// safeCode keeps a code from the sidecar printable in a log or an error: a
// short word of letters, digits and underscores, or "other".
func safeCode(s string) string {
	if codeWord.MatchString(s) {
		return s
	}
	return "other"
}

// listenerCode is the websocket close code of a listener event, 0 when absent.
func listenerCode(s looseString) int {
	n, err := strconv.Atoi(string(s))
	if err != nil {
		return 0
	}
	return n
}
