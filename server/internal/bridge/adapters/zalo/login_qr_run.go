package zalo

import (
	"context"
	"errors"
	"fmt"
	"time"

	"app.local/server/internal/bridge"
)

// runQRLogin drives the sidecar of a login until it ends, is cancelled, or
// expires too many times; a QR code that expires is replaced by a new sidecar.
func (a *Adapter) runQRLogin(ctx context.Context, l *qrLogin) {
	defer close(l.finished)
	for refreshes := 0; ; refreshes++ {
		if expired := a.runQRSidecar(ctx, l); !expired || ctx.Err() != nil {
			return
		}
		if refreshes >= maxQRRefresh {
			l.fail(&bridge.InputError{Message: "qr_expired: the QR code expired, start the login again"})
			return
		}
		l.set(func(l *qrLogin) { l.phase, l.image = phaseStarting, "" })
	}
}

// runQRSidecar runs one sidecar of a login, recording what it reports. It
// returns true when the QR code expired and a new one is wanted. The sidecar
// is asked not to start the listener: the login ends at the account event,
// and the process is stopped right away.
func (a *Adapter) runQRSidecar(ctx context.Context, l *qrLogin) (expired bool) {
	side, err := startSidecar(ctx, a.runner, a.logger, a.timing)
	if err != nil {
		if ctx.Err() == nil {
			l.fail(err)
		}
		return false
	}
	defer side.stop()
	noListener := false
	if err := side.send(command{Cmd: cmdLoginQR, Listen: &noListener}); err != nil {
		l.fail(err)
		return false
	}
	firstQR := time.NewTimer(a.timing.firstQR)
	defer firstQR.Stop()
	var session *sidecarSession
	for {
		var ev wireEvent
		var ok bool
		select {
		case <-ctx.Done():
			return false
		case <-firstQR.C:
			l.fail(errors.New("zalo: no QR code from Zalo in time"))
			return false
		case ev, ok = <-side.events:
		}
		if !ok {
			l.fail(errors.New("zalo: the login process stopped"))
			return false
		}
		switch ev.Ev {
		case evQR:
			image, err := qrDataURL(ev.Image)
			if err != nil {
				l.fail(err)
				return false
			}
			firstQR.Stop()
			l.set(func(l *qrLogin) { l.phase, l.image = phaseShowing, image })
		case evQRScanned:
			l.set(func(l *qrLogin) { l.phase = phaseScanned })
		case evQRExpired:
			return true
		case evQRDeclined:
			l.fail(&bridge.InputError{Message: "qr_declined: the login was declined on the phone, start it again"})
			return false
		case evLoggedIn:
			s, err := parseSidecarSession(ev.Session)
			if err != nil {
				l.fail(err)
				return false
			}
			session = &s
		case evAccount:
			a.finishQRLogin(l, session, string(ev.UID))
			return false
		case evError:
			l.fail(fmt.Errorf("zalo: QR login failed (%s)", safeCode(string(ev.Code))))
			return false
		}
	}
}

// finishQRLogin records the session and account, or fails the login when the
// account came first or its id is not a Zalo user id.
func (a *Adapter) finishQRLogin(l *qrLogin, session *sidecarSession, uid string) {
	if session == nil {
		l.fail(errors.New("zalo: login reported the account before the session"))
		return
	}
	sealed, err := sealable(*session, uid)
	if err != nil {
		l.fail(errors.New("zalo: login finished without a valid account id"))
		return
	}
	l.set(func(l *qrLogin) { l.phase, l.session, l.uid = phaseDone, sealed, uid })
}
