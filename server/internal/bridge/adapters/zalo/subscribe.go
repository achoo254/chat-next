package zalo

import (
	"context"
	"errors"
	"fmt"
	"sync/atomic"
	"time"

	"app.local/server/internal/bridge"
)

// subscription is the sidecar listening for one account.
type subscription struct {
	side      *sidecar
	loggedOut atomic.Bool
}

// Subscribe implements bridge.Adapter: it starts a sidecar with the stored
// session and delivers 1-1 messages until ctx ends or the sidecar stops. Every
// stop is an error the engine retries with its backoff (one sidecar per
// call), except a session Zalo keeps refusing, which is ErrSessionRevoked.
// Zalo cannot replay what was missed while offline, so acct.State is unused.
func (a *Adapter) Subscribe(ctx context.Context, acct bridge.Account, out chan<- bridge.Event) error {
	sess, err := parseSession(acct.Session)
	if err != nil {
		return fmt.Errorf("%w: %w", bridge.ErrSessionRevoked, err)
	}
	side, err := startSidecar(ctx, a.runner, a.logger, a.timing)
	if err != nil {
		return err
	}
	sub := &subscription{side: side}
	a.mu.Lock()
	previous := a.subs[acct.ID]
	a.subs[acct.ID] = sub
	a.mu.Unlock()
	if previous != nil {
		previous.side.stop() // one listener per account: Zalo kicks the older one anyway
	}
	defer func() {
		side.stop()
		a.mu.Lock()
		if a.subs[acct.ID] == sub {
			delete(a.subs, acct.ID)
		}
		a.mu.Unlock()
	}()
	if err := side.send(command{Cmd: cmdLoginSession, Session: sess}); err != nil {
		return err
	}
	return a.listen(ctx, acct.ID, sub, out)
}

// listen handles the events of a subscribed sidecar.
func (a *Adapter) listen(ctx context.Context, account string, sub *subscription, out chan<- bridge.Event) error {
	heard := a.heardFor(account)
	connected := false
	groupsIgnored := 0
	for {
		var ev wireEvent
		var ok bool
		select {
		case <-ctx.Done():
			return ctx.Err()
		case ev, ok = <-sub.side.events:
		}
		if !ok {
			if sub.loggedOut.Load() {
				return fmt.Errorf("%w: logged out from Chat", bridge.ErrSessionRevoked)
			}
			return errors.New("zalo: sidecar exited")
		}
		switch ev.Ev {
		case evMessage:
			if ev.Thread == threadGroup {
				groupsIgnored++
				a.logger.Debug("zalo group message ignored", "ignored_since_connect", groupsIgnored)
				continue
			}
			if err := a.deliver(ctx, heard, ev, out); err != nil {
				return err
			}
		case evListener:
			code := listenerCode(ev.Code)
			switch ev.State {
			case "connected":
				connected = true
				a.resetRejections(account)
				a.logger.Info("zalo listener connected")
			case "closed":
				return listenerClosed(code)
			default:
				a.logger.Debug("zalo listener state", "state", safeCode(ev.State), "code", code)
			}
		case evError:
			if err := a.sidecarError(account, ev, connected); err != nil {
				return err
			}
		default:
			// account, other listener events (typing, reaction, undo, seen...):
			// no feature declared for them in this step.
		}
	}
}

// deliver maps a 1-1 message, drops a repeat, remembers it for ListConversations
// and Backfill, then hands it to the engine.
func (a *Adapter) deliver(ctx context.Context, heard *heardAccount, ev wireEvent, out chan<- bridge.Event) error {
	m, conv, err := mapMessage(ev, time.Now())
	if err != nil {
		a.logger.Debug("zalo message dropped", "reason", err.Error())
		return nil
	}
	if !heard.firstSighting(m.ID) {
		return nil
	}
	heard.record(conv, m)
	select {
	case <-ctx.Done():
		return ctx.Err()
	case out <- bridge.Event{Message: &m}:
		return nil
	}
}

// revokeAfter is how many session logins in a row Zalo must refuse before the
// session counts as ended. One refusal can be a passing fault on Zalo's side,
// and calling it revoked makes the owner scan a QR code again.
const revokeAfter = 3

// sidecarError classifies an error event. Before the listener connects, a
// failed login_session whose error is Zalo's own (ZaloApiError: Zalo answered
// and refused the session) counts toward revokeAfter; a network failure does
// not. Other errors are followed by the listener closing or the process
// exiting, which ends the subscription.
func (a *Adapter) sidecarError(account string, ev wireEvent, connected bool) error {
	code := safeCode(string(ev.Code))
	kind := safeCode(ev.Message)
	if connected || code != "command_failed" {
		a.logger.Debug("zalo sidecar error", "code", code, "kind", kind)
		return nil
	}
	if kind != "ZaloApiError" {
		return fmt.Errorf("zalo: login with the stored session failed (%s)", kind)
	}
	a.mu.Lock()
	a.rejections[account]++
	n := a.rejections[account]
	if n >= revokeAfter {
		delete(a.rejections, account)
	}
	a.mu.Unlock()
	if n >= revokeAfter {
		return fmt.Errorf("%w: Zalo refused the stored session %d times in a row", bridge.ErrSessionRevoked, n)
	}
	return fmt.Errorf("zalo: Zalo refused the stored session (%d of %d before it counts as ended)", n, revokeAfter)
}

func (a *Adapter) resetRejections(account string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.rejections, account)
}

// Websocket close codes the listener reports (zca-js CloseReason).
const (
	closeDuplicateConnection = 3000 // another Zalo Web session took over
	closeKicked              = 3003
)

// listenerClosed is the retryable error of a closed listener. 3000 and 3003
// mean Zalo moved the session elsewhere; reconnecting takes it back, so the
// engine's backoff decides when.
func listenerClosed(code int) error {
	switch code {
	case closeDuplicateConnection:
		return errors.New("zalo: listener closed, another Zalo Web session is open (code 3000)")
	case closeKicked:
		return errors.New("zalo: listener closed by Zalo (code 3003)")
	}
	return fmt.Errorf("zalo: listener closed (code %d)", code)
}
