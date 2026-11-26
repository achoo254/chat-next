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
	var topicID int64
	if s.Topic != "" {
		id, ok, err := lookupTopic(ctx, r.e.db.pool, r.account.ID, s.Conversation, s.Topic)
		if err != nil || !ok {
			return false, err // a topic Chat does not have: nothing to read
		}
		topicID = id
	}
	err = r.withLink(ctx, l, func(it *chat.ImportTx) error {
		var err error
		if s.Topic != "" {
			_, err = it.MarkOwnerTopicRead(ctx, topicID, seq)
		} else {
			_, err = it.MarkOwnerRead(ctx, seq)
		}
		if err != nil {
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
		Seq   int64 `json:"seq"`
		Topic int64 `json:"topic"`
	}
	if err := json.Unmarshal(h.Payload, &p); err != nil {
		return db.setOutbox(ctx, []int64{h.ID}, "failed", "bad payload", time.Time{})
	}
	// A topic read goes to that topic of the other app.
	var topic string
	var topicWriter bridge.TopicReadWriter
	if p.Topic != 0 {
		ext, ok, err := externalTopic(ctx, db.pool, r.account.ID, h.ExternalChat, p.Topic)
		if err != nil {
			return err
		}
		tw, can := r.adapter.(bridge.TopicReadWriter)
		if !ok || !can {
			return db.setOutbox(ctx, []int64{h.ID}, "cancelled", "", time.Time{})
		}
		topic, topicWriter = ext, tw
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
	if topicWriter != nil {
		err = topicWriter.MarkTopicRead(ctx, r.acct, h.ExternalChat, topic, id)
	} else {
		err = w.MarkRead(ctx, r.acct, h.ExternalChat, id)
	}
	if err != nil {
		return r.settleCall(ctx, []*outboxRow{h}, err)
	}
	return db.setOutbox(ctx, []int64{h.ID}, "sent", "", time.Time{})
}
