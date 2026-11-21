package zalo

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"sync"
	"time"

	"app.local/server/internal/bridge"
)

// maxQRRefresh is how many times an expired QR code (about 100 s each) is
// replaced by a new one before the login gives up.
const maxQRRefresh = 3

// maxQRImageBytes bounds a decoded QR image.
const maxQRImageBytes = 256 << 10

var pngMagic = []byte("\x89PNG\r\n\x1a\n")

// loginPhase is where a QR login is.
type loginPhase int

const (
	phaseStarting loginPhase = iota // the sidecar is starting: no QR code yet
	phaseShowing                    // a QR code to scan
	phaseScanned                    // scanned; the phone has to confirm
	phaseDone                       // session and account known
	phaseFailed                     // ended without a session
)

// qrLogin is one QR login. Its sidecar is driven by runQRLogin on its own
// goroutine, which records each change here; Login calls only read it, so no
// request waits on Zalo. changed is closed and replaced at every change.
type qrLogin struct {
	id, owner string
	cancel    context.CancelFunc
	finished  chan struct{} // closed when runQRLogin returns
	idle, ttl *time.Timer

	mu       sync.Mutex
	phase    loginPhase
	image    string // data: URL of the current QR code
	session  []byte // sealable, at phaseDone
	uid      string
	failure  error // at phaseFailed
	version  int
	reported int // version last returned to a Login call
	changed  chan struct{}
}

func newQRLogin(id, owner string) *qrLogin {
	return &qrLogin{id: id, owner: owner, finished: make(chan struct{}), changed: make(chan struct{})}
}

// set applies a change and wakes the waiting Login call. Nothing changes once
// the login is done or failed.
func (l *qrLogin) set(change func(l *qrLogin)) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.phase >= phaseDone {
		return
	}
	change(l)
	l.version++
	close(l.changed)
	l.changed = make(chan struct{})
}

func (l *qrLogin) fail(err error) {
	l.set(func(l *qrLogin) { l.phase, l.failure = phaseFailed, err })
}

// loginView is a copy of a login's state, read under its lock.
type loginView struct {
	phase   loginPhase
	image   string
	session []byte
	uid     string
	failure error
}

// view marks the current state as reported and returns it. Call with l.mu.
func (l *qrLogin) view() loginView {
	l.reported = l.version
	return loginView{phase: l.phase, image: l.image, session: l.session, uid: l.uid, failure: l.failure}
}

// stop ends the login's sidecar and timers. It does not wait.
func (l *qrLogin) stop() {
	if l.idle != nil {
		l.idle.Stop()
	}
	if l.ttl != nil {
		l.ttl.Stop()
	}
	if l.cancel != nil {
		l.cancel()
	}
}

// step is what the user sees for a login still running: the QR code (an
// empty Prompt while it is being made: poll again), or the wait for the
// phone's confirmation.
func (v loginView) step(id string) bridge.LoginStep {
	if v.phase == phaseScanned {
		return bridge.LoginStep{Kind: bridge.StepConfirm, Token: id, Prompt: "Confirm the login in Zalo on your phone."}
	}
	return bridge.LoginStep{Kind: bridge.StepQR, Token: id, Prompt: v.image}
}

// qrDataURL checks the QR image (base64 PNG, bounded) and returns it as a
// data: URL the client can show as is.
func qrDataURL(b64 string) (string, error) {
	if len(b64) == 0 || base64.StdEncoding.DecodedLen(len(b64)) > maxQRImageBytes {
		return "", errors.New("zalo: QR image missing or too large")
	}
	img, err := base64.StdEncoding.DecodeString(b64)
	if err != nil || !bytes.HasPrefix(img, pngMagic) {
		return "", errors.New("zalo: QR image is not a PNG")
	}
	return "data:image/png;base64," + b64, nil
}
