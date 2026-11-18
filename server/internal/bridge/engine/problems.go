package engine

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// Problem is something Chat queued for the other app that did not go through, of any feature:
// the one place to see why, try again or give it up.
type Problem struct {
	ID        int64
	ChatID    int64
	ChatTitle string
	Feature   string
	Op        string
	Seq       int64
	// Status is failed, or unknown when a send was in flight too long ago to retry on its own.
	Status    string
	LastError string
	Attempts  int
	At        time.Time
}

// problemsMax is how many problems are listed, the newest first.
const problemsMax = 200

// Problems lists the failed and unknown rows of the account's outbox, newest first.
func (e *Engine) Problems(ctx context.Context, owner, accountID int64) ([]Problem, error) {
	if _, err := e.ownedAccount(ctx, owner, accountID); err != nil {
		return nil, err
	}
	rows, err := e.db.pool.Query(ctx, `
		SELECT o.id, o.chat_id, x.title, CASE WHEN o.feature = '' THEN 'messages' ELSE o.feature END,
			o.op, o.seq, o.status, o.last_error, o.attempts, o.updated_at
		FROM external_outbox o JOIN external_chats x ON x.account_id = o.account_id AND x.external_chat_id = o.external_chat_id
		WHERE o.account_id = $1 AND o.status IN ('failed', 'unknown') ORDER BY o.updated_at DESC, o.id DESC LIMIT $2`, accountID, problemsMax)
	if err != nil {
		return nil, fmt.Errorf("bridge: list problems: %w", err)
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Problem, error) {
		var p Problem
		err := r.Scan(&p.ID, &p.ChatID, &p.ChatTitle, &p.Feature, &p.Op, &p.Seq, &p.Status, &p.LastError, &p.Attempts, &p.At)
		return p, err
	})
}

// RetryProblem queues a failed or unknown row again. A send in a chat that no longer sends
// is not retried (ErrNotFound), as for RetryMessage.
func (e *Engine) RetryProblem(ctx context.Context, owner, accountID, id int64) error {
	tag, err := e.db.pool.Exec(ctx, `
		UPDATE external_outbox o SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = '', updated_at = now()
		FROM external_chats x JOIN external_accounts a ON a.id = x.account_id
		WHERE o.id = $1 AND o.account_id = $2 AND o.status IN ('failed', 'unknown')
			AND x.account_id = o.account_id AND x.external_chat_id = o.external_chat_id
			AND a.owner_id = $3 AND a.status = 'active' AND (o.op <> 'send' OR x.direction = 'both')`, id, accountID, owner)
	if err != nil {
		return fmt.Errorf("bridge: retry problem: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// DismissProblem gives up a failed or unknown row of any kind except a send (a message that
// was not sent is given up by deleting it in Chat).
func (e *Engine) DismissProblem(ctx context.Context, owner, accountID, id int64) error {
	tag, err := e.db.pool.Exec(ctx, `
		UPDATE external_outbox o SET status = 'cancelled', updated_at = now()
		FROM external_accounts a
		WHERE o.id = $1 AND o.account_id = $2 AND o.status IN ('failed', 'unknown') AND o.op <> 'send'
			AND a.id = o.account_id AND a.owner_id = $3`, id, accountID, owner)
	if err != nil {
		return fmt.Errorf("bridge: dismiss problem: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
