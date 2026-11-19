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
// FloodWait becomes a RateLimitError, a dead session ErrSessionRevoked, a refusal
// about one conversation ErrNotAllowed. Anything else is returned as it is.
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
	if rpc, ok := tgerr.As(err); ok && refusedErrors[rpc.Type] {
		return fmt.Errorf("%w: %s", bridge.ErrNotAllowed, rpc.Type)
	}
	return err
}

// refusedErrors are Telegram's answers that it will not do this for one conversation
// (no right there, a peer it no longer knows, a private channel): retrying cannot help,
// and the engine skips that conversation instead of stopping the account's sync.
var refusedErrors = map[string]bool{
	"CHAT_ADMIN_REQUIRED": true, "PEER_ID_INVALID": true, "CHANNEL_PRIVATE": true, "CHANNEL_INVALID": true,
	"CHAT_ID_INVALID": true, "CHAT_FORBIDDEN": true, "USER_BANNED_IN_CHANNEL": true, "CHANNEL_PUBLIC_GROUP_NA": true,
}
