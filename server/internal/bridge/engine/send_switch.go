package engine

import (
	"context"
	"fmt"

	"app.local/server/internal/bridge"
	"app.local/server/internal/chat"
)

// sendOffReason is why a row queued for an account whose sending switch is off is
// cancelled instead of sent.
const sendOffReason = "send_disabled: sending to this app is switched off for the account"

// adapterSends reports whether adapter can be written to at all.
func adapterSends(adapter bridge.Adapter) bool {
	if adapter == nil {
		return false
	}
	_, ok := adapter.(bridge.Sender)
	return ok && adapter.Capabilities().Has(bridge.CapSend)
}

// sendGated reports whether adapter is written to only for an account whose owner
// switched sending on.
func sendGated(adapter bridge.Adapter) bool {
	_, ok := adapter.(bridge.SendGated)
	return ok
}

// sendSwitchable reports whether the owner has a sending switch to turn for an
// account of adapter: the adapter gates sending and can send.
func sendSwitchable(adapter bridge.Adapter) bool {
	return adapterSends(adapter) && sendGated(adapter)
}

// SetSendEnabled turns the sending switch of an account of owner on or off, for an
// app that gates sending per account. On: the chats of every conversation the app
// still lists send what the owner writes in Chat on to the app, once the account's
// runner lists them (a conversation left or deleted stays read-only). Off: every
// chat of the account is read-only again and what is queued for the app is
// cancelled. Turning it on needs a connected account; turning it off never does.
// ErrSendUnsupported for an app that is not gated or cannot be written to.
func (e *Engine) SetSendEnabled(ctx context.Context, owner, accountID int64, enabled bool) error {
	a, err := e.ownedAccount(ctx, owner, accountID)
	if err != nil {
		return err
	}
	if !sendSwitchable(e.adapters[a.Source]) {
		return ErrSendUnsupported
	}
	if enabled && a.Status != "active" {
		return ErrSendUnsupported
	}
	if _, err := e.db.pool.Exec(ctx, `UPDATE external_accounts SET send_enabled = $2, updated_at = now() WHERE id = $1`, a.ID, enabled); err != nil {
		return fmt.Errorf("bridge: set send switch: %w", err)
	}
	a.SendEnabled = enabled
	if !enabled {
		// The switch is off before anything is cancelled: a row the runner picks up
		// meanwhile is cancelled there too (sendRow).
		if err := e.db.cancelOutbox(ctx, a.ID, sendOffReason); err != nil {
			return err
		}
		if err := e.alignDirections(ctx, a, nil); err != nil {
			return err
		}
	}
	e.logger.Info("the sending switch of a bridge account changed", "account_id", a.ID, "source", a.Source, "send_enabled", enabled)
	e.wakeSync(a.ID)
	return nil
}

// alignDirections puts the chats of account a in step with what it may send: with
// sending allowed, the chats of the conversations in listed become two-way; without,
// every chat becomes read-only. Each change goes through the chat service, which
// tells the owner's open sessions and drops what a read-only chat had queued.
func (e *Engine) alignDirections(ctx context.Context, a *accountRow, listed map[string]bool) error {
	allowed := e.canSend(a)
	links, err := e.db.links(ctx, a.ID)
	if err != nil {
		return err
	}
	for _, l := range links {
		want := chat.DirectionIn
		if allowed {
			// Sending allowed only raises: a chat whose conversation is not listed stays
			// as it is, and a two-way chat is never lowered here.
			if l.Direction != chat.DirectionIn || !listed[l.ExternalChat] {
				continue
			}
			want = chat.DirectionBoth
		} else if l.Direction == chat.DirectionIn {
			continue
		}
		if err := e.chat.SetImportedDirection(ctx, a.OwnerID, l.ChatID, want); err != nil {
			return err
		}
	}
	return nil
}

// alignSendDirection keeps the chats of an account of a gated app in step with its
// sending switch, read again here as the owner may have turned it since the runner
// started. Called with the conversations the app lists now.
func (r *runner) alignSendDirection(ctx context.Context, list []bridge.Conversation) error {
	if !sendSwitchable(r.adapter) {
		return nil
	}
	on, err := r.e.db.sendEnabled(ctx, r.account.ID)
	if err != nil {
		return err
	}
	r.account.SendEnabled = on
	listed := make(map[string]bool, len(list))
	for _, c := range list {
		listed[c.ID] = true
	}
	if err := r.e.alignDirections(ctx, r.account, listed); err != nil {
		return err
	}
	// The runner's own copy of each link follows (the look for conversations gone
	// from the app asks only about two-way ones).
	links, err := r.e.db.links(ctx, r.account.ID)
	if err != nil {
		return err
	}
	for _, l := range links {
		if have := r.links[l.ExternalChat]; have != nil {
			have.Direction = l.Direction
		}
	}
	return nil
}

// wakeSync asks the runner of an account, if one runs here, to read the account's
// switches again and list its conversations.
func (e *Engine) wakeSync(accountID int64) {
	// The runner is read under the lock: a handle is registered before its runner exists, and an
	// account that is still connecting reads its switches from the row when it does.
	e.mu.Lock()
	var r *runner
	if h := e.runners[accountID]; h != nil {
		r = h.r
	}
	e.mu.Unlock()
	if r != nil {
		select {
		case r.syncNow <- struct{}{}:
		default: // already asked
		}
	}
}

// sendEnabled reads the sending switch of an account now.
func (d *db) sendEnabled(ctx context.Context, accountID int64) (bool, error) {
	var on bool
	if err := d.pool.QueryRow(ctx, `SELECT send_enabled FROM external_accounts WHERE id = $1`, accountID).Scan(&on); err != nil {
		return false, fmt.Errorf("bridge: read send switch: %w", err)
	}
	return on, nil
}

// cancelOutbox cancels everything an account has queued for the other app and not
// finished, with reason as its last error ("" keeps the one it had).
func (d *db) cancelOutbox(ctx context.Context, accountID int64, reason string) error {
	if _, err := d.pool.Exec(ctx, `
		UPDATE external_outbox SET status = 'cancelled', last_error = CASE WHEN $2 = '' THEN last_error ELSE $2 END, updated_at = now()
		WHERE account_id = $1 AND status IN ('pending', 'sending', 'failed', 'unknown')`, accountID, reason); err != nil {
		return fmt.Errorf("bridge: cancel outbox: %w", err)
	}
	return nil
}

// interruptedToUnknown turns every row of an account left in flight ('sending') by a
// run that stopped into 'unknown', instead of repeating it on its own.
func (d *db) interruptedToUnknown(ctx context.Context, accountID int64) error {
	if _, err := d.pool.Exec(ctx, `
		UPDATE external_outbox SET status = 'unknown', last_error = 'unclear whether it was sent', updated_at = now()
		WHERE account_id = $1 AND status = 'sending'`, accountID); err != nil {
		return fmt.Errorf("bridge: interrupted sends: %w", err)
	}
	return nil
}
