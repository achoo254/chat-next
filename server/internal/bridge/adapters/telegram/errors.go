package telegram

import (
	"fmt"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/tgerr"
)

// sessionErrors are the RPC errors that mean Telegram no longer accepts the
// stored login: the user ended the session, or the account is gone.
var sessionErrors = map[string]bool{
	"AUTH_KEY_UNREGISTERED": true, "SESSION_REVOKED": true, "SESSION_EXPIRED": true,
	"USER_DEACTIVATED": true, "USER_DEACTIVATED_BAN": true, "AUTH_KEY_INVALID": true, "AUTH_KEY_PERM_EMPTY": true,
}

// translate turns a Telegram error into what the engine understands: a
// FloodWait becomes a RateLimitError, a dead session ErrSessionRevoked.
// Anything else is returned as it is.
func translate(err error) error {
	if err == nil {
		return nil
	}
	if d, ok := tgerr.AsFloodWait(err); ok {
		return &bridge.RateLimitError{RetryAfter: d}
	}
	if rpc, ok := tgerr.As(err); ok && sessionErrors[rpc.Type] {
		return fmt.Errorf("%w: %s", bridge.ErrSessionRevoked, rpc.Type)
	}
	return err
}
