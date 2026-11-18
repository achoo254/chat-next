package chat

import (
	"context"
	"encoding/json"
	"fmt"

	"app.local/server/internal/bridge/feature"
)

// The state of a chat in the owner's list (mute, pinned, marked unread) reaches the
// other app through the outbox as a row that holds the state wanted. There is one row
// per kind of state per chat, so the next change replaces the one not yet sent; the
// row has no message, so its seq is 0.

// queueState queues the state wanted of a chat of me for the feature (notify, dialog, info
// or dialog) as op, with its payload, if the chat goes to another app for me.
//
// seq names the object the state is of when it is not the chat itself (a topic's id);
// without it the row is the chat's.
func (t *txn) queueState(ctx context.Context, chatID, me int64, feat feature.Feature, op string, payload map[string]any, seq ...int64) error {
	object := int64(0)
	if len(seq) > 0 {
		object = seq[0]
	}
	l, err := t.outboundLink(ctx, chatID, me, feat)
	if err != nil || l == nil {
		return err
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("chat: queue %s: %w", op, err)
	}
	if _, err := t.tx.Exec(ctx, `
		INSERT INTO external_outbox (account_id, external_chat_id, chat_id, seq, op, feature, payload) VALUES ($1, $2, $3, $7, $4, $5, $6)
		ON CONFLICT (chat_id, seq, op) DO UPDATE
			SET payload = EXCLUDED.payload, status = 'pending', attempts = 0, next_attempt_at = now(), last_error = '', updated_at = now()`,
		l.accountID, l.externalID, chatID, op, string(feat), body, object); err != nil {
		return fmt.Errorf("chat: queue %s: %w", op, err)
	}
	return nil
}
