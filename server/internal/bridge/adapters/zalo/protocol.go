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
// refused instead of half understood: the bundle ships in the same commit as
// this code and its hash is checked at startup, so only a broken deploy can
// pair them wrong. Version 3 lets a QR login skip the listener and names the
// reason of a failed login; version 4 sends a text to one person and reads
// the newest page of 1-1 messages (send, history); version 5 gives a history
// message the hash of its text instead of the text; version 6 gives a 1-1
// message the photo URL of the other person; version 7 the phone number their
// profile shows.
const protocolVersion = 7

// maxLineBytes bounds one line of the sidecar's stdout. A QR image is about
// 10 KiB and a text message far less; a longer line is a broken sidecar.
const maxLineBytes = 1 << 20

// Commands the sidecar reads on stdin.
const (
	cmdLoginQR      = "login_qr"
	cmdLoginSession = "login_session"
	cmdSend         = "send"
	cmdHistory      = "history"
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
	// Answers to a command with an id (send, history). They are routed to
	// the caller by id and never reach the listener's loop.
	evSent         = "sent"
	evSendError    = "send_error"
	evHistory      = "history"
	evHistoryError = "history_error"
)

// isAnswer reports whether an event answers a command with an id.
func isAnswer(ev string) bool {
	return ev == evSent || ev == evSendError || ev == evHistory || ev == evHistoryError
}

// command is one line written to the sidecar.
type command struct {
	Cmd     string          `json:"cmd"`
	Session json.RawMessage `json:"session,omitempty"`
	// Listen false asks login_qr to stop at the account event (protocol 3).
	Listen *bool `json:"listen,omitempty"`
	// ID names a send or history command; its answer carries it back.
	ID   string `json:"id,omitempty"`
	To   string `json:"to,omitempty"`   // send: the person's Zalo id
	Text string `json:"text,omitempty"` // send: never logged
	Peer string `json:"peer,omitempty"` // history: the person's Zalo id
}

// errCodeSessionRejected is the error code of a login Zalo refused (sidecar
// src/login-failure.mjs); the other codes only say the login failed.
const errCodeSessionRejected = "session_rejected"

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
	// PeerName is the other person's name looked up by the sidecar for a message
	// the owner sent (there dName is the owner's own name).
	PeerName string `json:"peerName"`
	// PeerAvatar is the https URL of the other person's photo, "" when unknown.
	PeerAvatar string `json:"peerAvatar"`
	// PeerPhone is the phone number the other person's profile shows, from the
	// same lookup as the name; "" when it shows none or was not looked up. It
	// is never logged.
	PeerPhone string      `json:"peerPhone"`
	TS        looseString `json:"ts"`
	// event, listener, error
	Name    string          `json:"name"`
	Payload json.RawMessage `json:"payload"`
	State   string          `json:"state"`
	Code    looseString     `json:"code"`
	Message string          `json:"message"`
	// answers: sent, send_error, history, history_error
	ID       string           `json:"id"`
	ZaloCode looseString      `json:"zaloCode"`
	Count    int              `json:"count"`
	OldestTS looseString      `json:"oldestTs"`
	Messages []historyMessage `json:"messages"`
}

// historyMessage is one message of a history page (sidecar src/history.mjs).
// TextHash is the hash of the text of a text message (see hashText), empty
// otherwise: matching needs equality only, and a page of hashes keeps the line
// short whatever the texts are.
type historyMessage struct {
	Self     bool        `json:"self"`
	MsgType  looseString `json:"msgType"`
	TextHash string      `json:"textHash"`
	MsgID    looseString `json:"msgId"`
	TS       looseString `json:"ts"`
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

// zaloID matches the ids of messages and of the people in them (decimal
// digits on the account observed; any short plain token is taken so an
// unexpected form drops nothing).
var zaloID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// accountUID matches the id of the signed-in account, which keys the external
// account: decimal digits only, so "undefined" or "null" never pass.
var accountUID = regexp.MustCompile(`^[0-9]{1,20}$`)

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
