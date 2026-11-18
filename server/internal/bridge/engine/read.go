package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"app.local/server/internal/bridge"
	"app.local/server/internal/chat"
)

// onSeen applies "the owner read the chat on another device of the other app": the owner's
// read position in Chat moves up to the newest imported message at or below the one named.
func (r *runner) onSeen(ctx context.Context, ev bridge.Event, s bridge.Seen) (bool, error) {
	l := r.links[s.Conversation]
	if l == nil || !l.BackfillDone {
		return false, nil
	}
	seq, err := newestSeqUpTo(ctx, r.e.db.pool, r.account.ID, s.Conversation, s.MaxID)
	if err != nil || seq == 0 {
		return false, err
	}
	err = r.withLink(ctx, l, func(it *chat.ImportTx) error {
		if _, err := it.MarkOwnerRead(ctx, seq); err != nil {
			return err
		}
		return saveState(ctx, it.Tx(), r.account.ID, ev.State)
	})
	return true, err
}

// doMarkRead sends the owner's read position of the chat to the other app: the newest message
// of the other app at or below the seq the owner read up to.
func (r *runner) doMarkRead(ctx context.Context, h *outboxRow) error {
	db := r.e.db
	w, ok := r.adapter.(bridge.ReadWriter)
	if !ok {
		return db.setOutbox(ctx, []int64{h.ID}, "failed", "read_unsupported: this app cannot be told what was read from Chat", time.Time{})
	}
	if err := db.startSendingState(ctx, h); err != nil {
		return err
	}
	var p struct {
		Seq int64 `json:"seq"`
	}
	if err := json.Unmarshal(h.Payload, &p); err != nil {
		return db.setOutbox(ctx, []int64{h.ID}, "failed", "bad payload", time.Time{})
	}
	var id string
	err := db.pool.QueryRow(ctx, `
		SELECT external_msg_id FROM external_messages
		WHERE account_id = $1 AND external_chat_id = $2 AND seq <= $3 ORDER BY seq DESC LIMIT 1`,
		r.account.ID, h.ExternalChat, p.Seq).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return db.setOutbox(ctx, []int64{h.ID}, "cancelled", "", time.Time{})
	}
	if err != nil {
		return fmt.Errorf("bridge: newest message to mark read: %w", err)
	}
	if err := w.MarkRead(ctx, r.acct, h.ExternalChat, id); err != nil {
		return r.settleCall(ctx, []*outboxRow{h}, err)
	}
	return db.setOutbox(ctx, []int64{h.ID}, "sent", "", time.Time{})
}
