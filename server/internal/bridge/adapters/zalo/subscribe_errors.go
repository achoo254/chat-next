package zalo

import (
	"errors"
	"fmt"

	"app.local/server/internal/bridge"
)

// errAccountMismatch: the stored session logged in as another Zalo account
// than the one it was saved for. Retrying cannot fix it, and it is not a
// revoked session either; the adapter refuses that session (without starting
// a sidecar) until the account signs in again.
var errAccountMismatch = errors.New("zalo: the stored session belongs to another Zalo account; sign in again")

// checkAccount compares the account the sidecar logged in as with the one the
// session was saved for.
func (a *Adapter) checkAccount(st *listening, uid string) error {
	if uid == st.uid {
		return nil
	}
	a.mu.Lock()
	a.mismatched[st.account] = st.fingerprint
	a.mu.Unlock()
	a.logger.Error("zalo stored session logged in as another account; it will not be used again")
	return errAccountMismatch
}

// listenerState handles a listener event: connected clears the refusal
// streak; closed ends the subscription.
func (a *Adapter) listenerState(st *listening, ev wireEvent) error {
	code := listenerCode(ev.Code)
	switch ev.State {
	case "connected":
		st.connected = true
		a.refusals.connected(st.account)
		a.logger.Info("zalo listener connected")
	case "closed":
		return listenerClosed(code)
	default:
		a.logger.Debug("zalo listener state", "state", safeCode(ev.State), "code", code)
	}
	return nil
}

// sidecarError classifies an error event. Before the listener connects, the
// login with the stored session failed: session_rejected (Zalo refused it)
// counts toward ErrSessionRevoked, spread over time (session_refusals.go);
// any other reason (zalo_unavailable, network_error, ...) neither counts nor
// clears the streak. After the listener connects, an error is followed by the
// listener closing or the process exiting, which ends the subscription.
func (a *Adapter) sidecarError(st *listening, ev wireEvent) error {
	code := safeCode(string(ev.Code))
	if st.connected {
		a.logger.Debug("zalo sidecar error", "code", code)
		return nil
	}
	if code != errCodeSessionRejected {
		return fmt.Errorf("zalo: login with the stored session failed (%s)", code)
	}
	revoked, counted := a.refusals.refused(st.account)
	if revoked {
		return fmt.Errorf("%w: Zalo kept refusing the stored session for over %v", bridge.ErrSessionRevoked, revokeMinSpan)
	}
	return fmt.Errorf("zalo: Zalo refused the stored session (%d counted; revoked after %d over %v)", counted, revokeMinRefusals, revokeMinSpan)
}

// Websocket close codes the listener reports (zca-js CloseReason).
const (
	closeDuplicateConnection = 3000 // another Zalo Web session took over
	closeKicked              = 3003
)

// listenerClosed is the retryable error of a closed listener. 3000 and 3003
// mean Zalo moved the session elsewhere (Zalo Web opened in a browser, Zalo PC
// signing in or out). Reconnecting takes it back and kicks the other side, so
// a browser tab of Zalo Web and this account take turns at each engine
// backoff (at most every 5 minutes) for as long as both are open.
func listenerClosed(code int) error {
	switch code {
	case closeDuplicateConnection:
		return errors.New("zalo: listener closed, another Zalo Web session is open (code 3000)")
	case closeKicked:
		return errors.New("zalo: listener closed by Zalo (code 3003)")
	}
	return fmt.Errorf("zalo: listener closed (code %d)", code)
}
