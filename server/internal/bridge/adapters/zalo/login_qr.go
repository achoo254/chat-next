package zalo

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"app.local/server/internal/bridge"
)

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
