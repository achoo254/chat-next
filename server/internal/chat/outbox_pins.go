package chat

import (
	"context"
	"fmt"
)

// Pins reach the other app through the same outbox as messages. One row per
// message (or per topic) holds the state wanted, so pinning and unpinning in a
// row leaves a single row with the last state: the order of rows never makes
// the other app end up in the wrong state.

// queuePinOp queues the state wanted for a message (op pin_message, seq the
// message) or a topic (op pin_topic, seq the topic id) of me, if its chat goes
// to another app.
func (t *txn) queuePinOp(ctx context.Context, chatID, me, seq int64, op string, pinned bool) error {
	l, err := t.outboundLink(ctx, chatID, me)
	if err != nil || l == nil {
		return err
	}
	if _, err := t.tx.Exec(ctx, `
		INSERT INTO external_outbox (account_id, external_chat_id, chat_id, seq, op, pinned) VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (chat_id, seq, op) DO UPDATE
			SET pinned = EXCLUDED.pinned, status = 'pending', attempts = 0, next_attempt_at = now(), last_error = '', updated_at = now()`,
		l.accountID, l.externalID, chatID, seq, op, pinned); err != nil {
		return fmt.Errorf("chat: queue %s: %w", op, err)
	}
	return nil
}

func (t *txn) queuePin(ctx context.Context, chatID, me, seq int64, pinned bool) error {
	return t.queuePinOp(ctx, chatID, me, seq, "pin_message", pinned)
}

func (t *txn) queueTopicPin(ctx context.Context, chatID, me, topicID int64, pinned bool) error {
	return t.queuePinOp(ctx, chatID, me, topicID, "pin_topic", pinned)
}

// mayPinTopicOutward reports whether me may change the pin of a topic of a
// chat linked to another app: only when the chat sends to that app for me.
func (t *txn) mayPinTopicOutward(ctx context.Context, chatID, me int64) (bool, error) {
	l, err := t.outboundLink(ctx, chatID, me)
	return l != nil, err
}
