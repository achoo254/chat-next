package zalo

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
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

// qrLogin is a QR login between two Login calls: its sidecar waits for the
// phone to scan and confirm. The engine calls Login for one login at a time;
// mu also guards against the expiry timer.
type qrLogin struct {
	mu        sync.Mutex
	side      *sidecar
	image     string // data: URL of the current QR code
	scanned   bool
	session   []byte // set by logged_in, canonical
	refreshes int
	timer     *time.Timer
}

func (l *qrLogin) close() {
	if l.timer != nil {
		l.timer.Stop()
	}
	if l.side != nil {
		l.side.stop()
	}
}

// step is what the user sees while nothing new happened.
func (l *qrLogin) step(id string) bridge.LoginStep {
	if l.scanned || l.session != nil {
		return bridge.LoginStep{Kind: bridge.StepConfirm, Token: id, Prompt: "Confirm the login in Zalo on your phone."}
	}
	return bridge.LoginStep{Kind: bridge.StepQR, Token: id, Prompt: l.image}
}

// Login implements bridge.Adapter with a QR code: the first call starts a
// sidecar and returns StepQR, whose Prompt is a data: URL of the PNG to show.
// Each later call (no input) waits up to a short poll for news and returns
// the current step: StepQR again (a new code replaces an expired one),
// StepConfirm once scanned, StepDone with the session once confirmed. Nothing
// of the login is logged.
func (a *Adapter) Login(ctx context.Context, prior string, _ map[string]string) (bridge.LoginStep, error) {
	if prior == "" {
		return a.startQRLogin(ctx)
	}
	a.mu.Lock()
	l := a.logins[prior]
	a.mu.Unlock()
	if l == nil {
		return bridge.LoginStep{}, &bridge.InputError{Message: "login_expired: start the login again"}
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return a.advanceQRLogin(ctx, prior, l)
}

func (a *Adapter) startQRLogin(ctx context.Context) (bridge.LoginStep, error) {
	var raw [8]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return bridge.LoginStep{}, fmt.Errorf("zalo: login id: %w", err)
	}
	id := hex.EncodeToString(raw[:])
	l := &qrLogin{}
	if err := a.newQRCode(ctx, l); err != nil {
		return bridge.LoginStep{}, err
	}
	l.timer = time.AfterFunc(a.timing.loginTTL, func() {
		l.mu.Lock() // not under a Login call that uses the sidecar
		defer l.mu.Unlock()
		a.dropLogin(id)
	})
	a.mu.Lock()
	a.logins[id] = l
	a.mu.Unlock()
	return l.step(id), nil
}

// newQRCode starts a sidecar for l (stopping the old one) and waits for its
// first QR code.
func (a *Adapter) newQRCode(ctx context.Context, l *qrLogin) error {
	if l.side != nil {
		l.side.stop()
		l.side = nil
	}
	side, err := startSidecar(ctx, a.runner, a.logger, a.timing)
	if err != nil {
		return err
	}
	if err := side.send(command{Cmd: cmdLoginQR}); err != nil {
		side.stop()
		return err
	}
	timer := time.NewTimer(a.timing.firstQR)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			side.stop()
			return ctx.Err()
		case <-timer.C:
			side.stop()
			return errors.New("zalo: no QR code from Zalo in time")
		case ev, ok := <-side.events:
			switch {
			case !ok:
				side.stop()
				return errors.New("zalo: sidecar exited before showing a QR code")
			case ev.Ev == evError:
				side.stop()
				return fmt.Errorf("zalo: QR login failed (%s, %s)", safeCode(string(ev.Code)), safeCode(ev.Message))
			case ev.Ev == evQR:
				image, err := qrDataURL(ev.Image)
				if err != nil {
					side.stop()
					return err
				}
				l.side, l.image, l.scanned = side, image, false
				return nil
			}
		}
	}
}

// advanceQRLogin waits for the next login event of l, up to the poll time.
func (a *Adapter) advanceQRLogin(ctx context.Context, id string, l *qrLogin) (bridge.LoginStep, error) {
	poll := time.NewTimer(a.timing.loginPoll)
	defer poll.Stop()
	for {
		var ev wireEvent
		var ok bool
		select {
		case <-ctx.Done():
			return bridge.LoginStep{}, ctx.Err()
		case <-poll.C:
			return l.step(id), nil
		case ev, ok = <-l.side.events:
		}
		if !ok {
			a.dropLogin(id)
			return bridge.LoginStep{}, errors.New("zalo: the login process stopped")
		}
		switch ev.Ev {
		case evQR:
			image, err := qrDataURL(ev.Image)
			if err != nil {
				a.dropLogin(id)
				return bridge.LoginStep{}, err
			}
			l.image, l.scanned = image, false
			return l.step(id), nil
		case evQRScanned:
			l.scanned = true
			return l.step(id), nil
		case evQRExpired:
			if l.refreshes >= maxQRRefresh {
				a.dropLogin(id)
				return bridge.LoginStep{}, &bridge.InputError{Message: "qr_expired: the QR code expired, start the login again"}
			}
			l.refreshes++
			if err := a.newQRCode(ctx, l); err != nil {
				a.dropLogin(id)
				return bridge.LoginStep{}, err
			}
			return l.step(id), nil
		case evQRDeclined:
			a.dropLogin(id)
			return bridge.LoginStep{}, &bridge.InputError{Message: "qr_declined: the login was declined on the phone, start it again"}
		case evLoggedIn:
			sess, err := parseSession(ev.Session)
			if err != nil {
				a.dropLogin(id)
				return bridge.LoginStep{}, err
			}
			l.session = sess
		case evAccount:
			uid := string(ev.UID)
			if l.session == nil || !zaloID.MatchString(uid) {
				a.dropLogin(id)
				return bridge.LoginStep{}, errors.New("zalo: login finished without a session or an account id")
			}
			a.dropLogin(id)
			return bridge.LoginStep{Kind: bridge.StepDone, Session: l.session, Account: uid}, nil
		case evError:
			a.dropLogin(id)
			return bridge.LoginStep{}, fmt.Errorf("zalo: QR login failed (%s, %s)", safeCode(string(ev.Code)), safeCode(ev.Message))
		}
	}
}

// dropLogin forgets a login and stops its sidecar.
func (a *Adapter) dropLogin(id string) {
	a.mu.Lock()
	l := a.logins[id]
	delete(a.logins, id)
	a.mu.Unlock()
	if l != nil {
		l.close()
	}
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
