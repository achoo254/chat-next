package zalo

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
)

// sidecarSession is what the sidecar needs to log in again: the cookie jar,
// the device id and the browser it claimed to be.
type sidecarSession struct {
	Cookie    json.RawMessage `json:"cookie"`
	IMEI      string          `json:"imei"`
	UserAgent string          `json:"userAgent"`
}

// storedSession is what the engine seals: the sidecar's session and the Zalo
// account it belongs to, so a session is never used for another account.
type storedSession struct {
	sidecarSession
	UID string `json:"uid"`
}

// errBadSession never carries the session itself.
var errBadSession = errors.New("zalo: stored session is incomplete")

func (s sidecarSession) complete() bool {
	cookie := bytes.TrimSpace(s.Cookie)
	return len(cookie) > 0 && !bytes.Equal(cookie, []byte("null")) && s.IMEI != "" && s.UserAgent != ""
}

// parseSidecarSession checks the session of a logged_in event and keeps only
// its three fields.
func parseSidecarSession(raw []byte) (sidecarSession, error) {
	var s sidecarSession
	if err := json.Unmarshal(raw, &s); err != nil || !s.complete() {
		return sidecarSession{}, errBadSession
	}
	return s, nil
}

// sealable is the session handed to the engine at the end of a login.
func sealable(s sidecarSession, uid string) ([]byte, error) {
	if !accountUID.MatchString(uid) || !s.complete() {
		return nil, errBadSession
	}
	out, err := json.Marshal(storedSession{sidecarSession: s, UID: uid})
	if err != nil {
		return nil, errBadSession
	}
	return out, nil
}

// openStored reads a sealed session back: the JSON for login_session and the
// account it belongs to. A session without its account counts as incomplete.
func openStored(raw []byte) (forSidecar []byte, uid string, err error) {
	var s storedSession
	if err := json.Unmarshal(raw, &s); err != nil || !s.complete() || !accountUID.MatchString(s.UID) {
		return nil, "", errBadSession
	}
	forSidecar, err = json.Marshal(s.sidecarSession)
	if err != nil {
		return nil, "", errBadSession
	}
	return forSidecar, s.UID, nil
}

// sessionFingerprint names one stored session without revealing it.
func sessionFingerprint(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:8])
}
