package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/feature"
	"app.local/server/internal/chat"
)

const (
	// reactionsEvery: reactions mostly arrive as events; the newest messages of each
	// chat are also read once in this many looks at the state of the chats, for what
	// the other app did not tell (a chat where it sends no event, an event missed).
	reactionsEvery = 5
	// reactionsRecent is how many of the newest imported messages of a chat that read covers.
	reactionsRecent = 50
)

// onReactions applies the reactions of a message reported live.
func (r *runner) onReactions(ctx context.Context, ev bridge.Event, rs bridge.Reactions) (bool, error) {
	l := r.links[rs.Conversation]
	if l == nil || !l.BackfillDone {
		return false, nil
	}
	err := r.applyReactions(ctx, l, []bridge.Reactions{rs}, func(it *chat.ImportTx) error {
		return saveState(ctx, it.Tx(), r.account.ID, ev.State)
	})
	return true, err
}

// applyReactions makes the reactions of messages in Chat what the other app says. A
// message not imported is skipped; the owner's reaction is not touched while Chat has
// a change of it waiting to go out. after runs in the same transaction.
func (r *runner) applyReactions(ctx context.Context, l *chatLink, list []bridge.Reactions, after func(*chat.ImportTx) error) error {
	type item struct {
		seq  int64
		want []chat.ImportedReaction
		rs   bridge.Reactions
	}
	var items []item
	for _, rs := range list {
		have, err := lookupMessage(ctx, r.e.db.pool, r.account.ID, l.ExternalChat, rs.ID)
		if err != nil {
			return err
		}
		if have == nil {
			continue
		}
		it := item{seq: have.Seq, rs: rs}
		seen := map[int64]bool{}
		for _, re := range rs.List {
			uid, err := r.e.db.ensurePuppet(ctx, r.account, re.From)
			if err != nil {
				return err
			}
			if seen[uid] {
				continue // Chat keeps one reaction per person: the first named
			}
			seen[uid] = true
			it.want = append(it.want, chat.ImportedReaction{UserID: uid, Emoji: re.Emoji})
		}
		items = append(items, it)
	}
	if len(items) == 0 && after == nil {
		return nil
	}
	return r.withLink(ctx, l, func(it *chat.ImportTx) error {
		// Chat sets a reaction under the lock of the chat, held here: checked now,
		// nothing it queues slips in before the write.
		for _, x := range items {
			pending, err := pendingOpAt(ctx, it.Tx(), l.ChatID, x.seq, "set_reaction")
			if err != nil {
				return err
			}
			if _, err := it.SetReactions(ctx, x.seq, x.want, x.rs.Complete, pending || !x.rs.OwnerKnown); err != nil {
				return err
			}
		}
		if after != nil {
			return after(it)
		}
		return nil
	})
}

// pendingOpAt is pendingOp for the row of one object of the chat (a message's seq).
func pendingOpAt(ctx context.Context, q querier, chatID, seq int64, op string) (bool, error) {
	var n int
	if err := q.QueryRow(ctx, `SELECT count(*) FROM external_outbox WHERE chat_id = $1 AND seq = $2 AND op = $3 AND status IN ('pending', 'sending')`,
		chatID, seq, op).Scan(&n); err != nil {
		return false, fmt.Errorf("bridge: pending op: %w", err)
	}
	return n > 0, nil
}

// pollReactions reads the reactions of the newest imported messages of the chats
// where reactions come in, once in reactionsEvery looks.
func (r *runner) pollReactions(ctx context.Context) error {
	reader, ok := r.adapter.(bridge.ReactionReader)
	if !ok || !bridge.FeaturesOf(r.adapter)[feature.Reactions].In {
		return nil
	}
	r.reactionsTick++
	if (r.reactionsTick-1)%reactionsEvery != 0 {
		return nil
	}
	for conv, l := range r.links {
		if !l.BackfillDone {
			continue
		}
		dir, err := r.e.db.featureDirection(ctx, r.account.ID, l.ExternalChat, feature.Reactions)
		if err != nil {
			return err
		}
		if !dir.Receives() {
			continue
		}
		if err := r.readReactions(ctx, reader, l, conv, ""); err != nil {
			return err
		}
	}
	return nil
}

// readReactions asks the other app for the reactions of the newest imported messages
// of a chat (or of the one message id when it is set) and applies them.
func (r *runner) readReactions(ctx context.Context, reader bridge.ReactionReader, l *chatLink, conv, id string) error {
	ids := []string{id}
	if id == "" {
		var err error
		if ids, err = newestImported(ctx, r.e.db.pool, r.account.ID, conv, reactionsRecent); err != nil {
			return err
		}
	}
	if len(ids) == 0 {
		return nil
	}
	list, err := retryRateLimit(ctx, func() ([]bridge.Reactions, error) { return reader.MessageReactions(ctx, r.acct, conv, ids) })
	if err != nil {
		return r.skipRefused(err, "reactions", conv)
	}
	return r.applyReactions(ctx, l, list, nil)
}

// newestImported lists the external ids of the newest imported messages of a conversation.
func newestImported(ctx context.Context, q querier, account int64, conv string, n int) ([]string, error) {
	rows, err := q.Query(ctx, `
		SELECT external_msg_id FROM external_messages WHERE account_id = $1 AND external_chat_id = $2
		ORDER BY seq DESC LIMIT $3`, account, conv, n)
	if err != nil {
		return nil, fmt.Errorf("bridge: newest imported: %w", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("bridge: newest imported: %w", err)
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// doReaction sends the owner's reaction wanted by a row (its seq is the message). A
// reaction the other app refuses for good is put back: Chat reads the message's
// reactions from the other app again, so it never shows one the other app has not.
func (r *runner) doReaction(ctx context.Context, h *outboxRow) error {
	db := r.e.db
	writer, ok := r.adapter.(bridge.ReactionWriter)
	if !ok {
		return db.setOutbox(ctx, []int64{h.ID}, "failed", "reactions_unsupported: this app cannot take reactions from Chat", time.Time{})
	}
	k, err := externalOf(ctx, db.pool, h.ChatID, h.Seq)
	if err != nil {
		return err
	}
	if k == nil {
		if waiting, err := r.waitForSend(ctx, h); err != nil || waiting {
			return err
		}
		return db.setOutbox(ctx, []int64{h.ID}, "cancelled", "", time.Time{})
	}
	if err := db.startSendingState(ctx, h); err != nil {
		return err
	}
	var p struct {
		Emoji string `json:"emoji"`
	}
	if err := json.Unmarshal(h.Payload, &p); err != nil {
		return db.setOutbox(ctx, []int64{h.ID}, "failed", "bad payload", time.Time{})
	}
	if err := writer.SetReaction(ctx, r.acct, k.chat, k.msg, p.Emoji); err != nil {
		if serr := r.settleCall(ctx, []*outboxRow{h}, err); serr != nil {
			return serr
		}
		var status string
		if qerr := db.pool.QueryRow(ctx, `SELECT status FROM external_outbox WHERE id = $1`, h.ID).Scan(&status); qerr != nil {
			return qerr
		}
		reader, ok := r.adapter.(bridge.ReactionReader)
		l := r.links[k.chat]
		if status != "failed" || !ok || l == nil {
			return nil
		}
		return r.readReactions(ctx, reader, l, k.chat, k.msg)
	}
	return db.setOutbox(ctx, []int64{h.ID}, "sent", "", time.Time{})
}
