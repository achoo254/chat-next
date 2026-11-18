package chat

import (
	"context"
	"encoding/json"
	"fmt"

	"app.local/server/internal/bridge/feature"
)

// What Chat does to a person who is a puppet of another app (removing them,
// making them an admin) reaches that app only when the chat sends its members
// there for the owner, which is off until the owner turns it on (feature members,
// risk R3). A member who is not a puppet is Chat's own and nothing is queued.
// Each action is one row for the member, so the last one is what is sent.

// queueMemberAction queues op for the puppet userID of the chat, if the chat sends
// members to the other app for me and userID is a person of that app.
func (t *txn) queueMemberAction(ctx context.Context, chatID, me, userID int64, op string, payload map[string]any) error {
	l, err := t.outboundLink(ctx, chatID, me, feature.Members)
	if err != nil || l == nil {
		return err
	}
	var participant string
	err = t.tx.QueryRow(ctx, `SELECT external_user_id FROM external_users WHERE account_id = $1 AND user_id = $2`, l.accountID, userID).Scan(&participant)
	if isNoRows(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("chat: member of the other app: %w", err)
	}
	payload["participant"] = participant
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("chat: queue %s: %w", op, err)
	}
	if _, err := t.tx.Exec(ctx, `
		INSERT INTO external_outbox (account_id, external_chat_id, chat_id, seq, op, feature, payload) VALUES ($1, $2, $3, $4, $5, 'members', $6)
		ON CONFLICT (chat_id, seq, op) DO UPDATE
			SET payload = EXCLUDED.payload, status = 'pending', attempts = 0, next_attempt_at = now(), last_error = '', updated_at = now()`,
		l.accountID, l.externalID, chatID, userID, op, body); err != nil {
		return fmt.Errorf("chat: queue %s: %w", op, err)
	}
	return nil
}
