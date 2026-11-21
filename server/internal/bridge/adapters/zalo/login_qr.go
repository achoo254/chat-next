package zalo

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"

	"app.local/server/internal/bridge"
)

// Login implements bridge.Adapter with a QR code. The first call starts the
// login and returns within loginStartWait: StepQR, whose Prompt is a data:
// URL of the PNG to show, or empty while the code is being made. Each later
// call (no input) waits at most loginPoll for news and returns the current
// step: StepQR (a new code replaces an expired one), StepConfirm once
// scanned, StepDone with the session once confirmed. A login nobody polls for
// loginIdle is stopped. Nothing of the login is logged.
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
	l.idle.Reset(a.timing.loginIdle)
	return a.awaitQRLogin(ctx, l, a.timing.loginPoll)
}

func (a *Adapter) startQRLogin(ctx context.Context) (bridge.LoginStep, error) {
	var raw [8]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return bridge.LoginStep{}, fmt.Errorf("zalo: login id: %w", err)
	}
	l := newQRLogin(hex.EncodeToString(raw[:]), ownerKey(ctx))
	runCtx, cancel := context.WithCancel(context.Background())
	l.cancel = cancel
	l.ttl = time.AfterFunc(a.timing.loginTTL, func() { a.endLogin(l.id, true) })
	l.idle = time.AfterFunc(a.timing.loginIdle, func() { a.endLogin(l.id, true) })
	if err := a.admitLogin(l); err != nil {
		l.stop()
		return bridge.LoginStep{}, err
	}
	go a.runQRLogin(runCtx, l)
	return a.awaitQRLogin(ctx, l, a.timing.loginStartWait)
}

// awaitQRLogin returns as soon as the login changed since the last call, or
// after wait. A caller that gives up (ctx ends) ends the login: the engine
// forgets a login whose call failed, so nobody would come back for it.
func (a *Adapter) awaitQRLogin(ctx context.Context, l *qrLogin, wait time.Duration) (bridge.LoginStep, error) {
	timer := time.NewTimer(wait)
	defer timer.Stop()
	for {
		l.mu.Lock()
		if l.version != l.reported || l.phase >= phaseDone {
			v := l.view()
			l.mu.Unlock()
			return a.report(l, v)
		}
		changed := l.changed
		l.mu.Unlock()
		select {
		case <-ctx.Done():
			a.endLogin(l.id, true)
			return bridge.LoginStep{}, ctx.Err()
		case <-timer.C:
			l.mu.Lock()
			v := l.view()
			l.mu.Unlock()
			return a.report(l, v)
		case <-changed:
		}
	}
}

// report turns a view of the login into the step or error to return, ending
// the login when it is over.
func (a *Adapter) report(l *qrLogin, v loginView) (bridge.LoginStep, error) {
	switch v.phase {
	case phaseDone:
		a.endLogin(l.id, false)
		return bridge.LoginStep{Kind: bridge.StepDone, Session: v.session, Account: v.uid}, nil
	case phaseFailed:
		a.endLogin(l.id, true)
		return bridge.LoginStep{}, v.failure
	}
	return v.step(l.id), nil
}

// endLogin forgets a login and stops its sidecar; failed starts the user's
// wait before the next login (loginRetryGap).
func (a *Adapter) endLogin(id string, failed bool) {
	a.mu.Lock()
	l := a.logins[id]
	delete(a.logins, id)
	if l != nil && failed {
		a.loginFailedAt[l.owner] = a.now()
	}
	a.mu.Unlock()
	if l != nil {
		l.stop()
	}
}
