package engine

import (
	"context"
	"errors"
	"fmt"
	"time"

	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/feature"
	"app.local/server/internal/chat"
	"github.com/jackc/pgx/v5"
)

// Mentions of the owner follow the other app (Telegram): a message that mentions them
// stays unread until they see it, there or in Chat. Imported messages carry the app's
// word (ownerMention); the dialog poll watches the app's count and Chat's and, when one
// moves, takes the list of unread ones from the app (syncMentions); seeing one in
// Chat queues "read_mention", which tells the app (doReadMention).

// ownerMention is the chat side of the app's word on a message.
func ownerMention(m bridge.Mention) chat.MentionState {
	switch m {
	case bridge.MentionNone:
		return chat.MentionNone
	case bridge.MentionUnread:
		return chat.MentionUnread
	case bridge.MentionRead:
		return chat.MentionRead
	default:
		return chat.MentionUnknown
	}
}

// mentionCounts is the pair of counts a chat's mentions were last made to match at:
// the app's and Chat's. While both stay the same there is nothing to ask the app.
type mentionCounts struct{ app, chat int }

// syncMentions makes the owner's unread mentions of a chat the ones the app has, when the
// app's count (from the dialog poll) or Chat's moved since they last matched. Nothing is
// done while Chat has a "seen" waiting to go out, which the app does not count yet.
func (r *runner) syncMentions(ctx context.Context, l *chatLink, st bridge.DialogState) error {
	reader, ok := r.adapter.(bridge.MentionReader)
	if !ok || !st.MentionsKnown {
		return nil
	}
	dir, err := r.e.db.featureDirection(ctx, r.account.ID, l.ExternalChat, feature.Read)
	if err != nil || !dir.Receives() {
		return err
	}
	// A chat that does not tell the other app keeps what the owner saw in Chat.
	keepRead := !dir.Sends()
	if pending, err := pendingOp(ctx, r.e.db.pool, l.ChatID, "read_mention"); err != nil || pending {
		return err
	}
	var have int
	if err := r.withLink(ctx, l, func(it *chat.ImportTx) error {
		n, err := it.UnreadOwnerMentions(ctx)
		have = n
		return err
	}); err != nil {
		return err
	}
	now := mentionCounts{app: st.UnreadMentions, chat: have}
	// The same counts can hide different messages (one seen here, another there), so the
	// list is asked for whenever either count moved since the chat last matched.
	if r.mentionsAt[l.ExternalChat] == now {
		return nil
	}
	ids, err := retryRateLimit(ctx, func() ([]string, error) { return reader.UnreadMentions(ctx, r.acct, l.ExternalChat) })
	if err != nil {
		return err
	}
	var seqs []int64
	for _, id := range ids {
		m, err := lookupMessage(ctx, r.e.db.pool, r.account.ID, l.ExternalChat, id)
		if err != nil {
			return err
		}
		if m != nil {
			seqs = append(seqs, m.Seq) // older than the imported history: Chat cannot show it
		}
	}
	if err := r.withLink(ctx, l, func(it *chat.ImportTx) error {
		if _, err := it.SetOwnerMentions(ctx, seqs, keepRead); err != nil {
			return err
		}
		n, err := it.UnreadOwnerMentions(ctx)
		now.chat = n
		return err
	}); err != nil {
		return err
	}
	r.mentionsAt[l.ExternalChat] = now
	return nil
}

// doReadMention tells the app the owner saw a message that mentions them.
func (r *runner) doReadMention(ctx context.Context, h *outboxRow) error {
	db := r.e.db
	w, ok := r.adapter.(bridge.MentionReader)
	if !ok {
		return db.setOutbox(ctx, []int64{h.ID}, "cancelled", "", time.Time{})
	}
	if err := db.startSendingState(ctx, h); err != nil {
		return err
	}
	var id string
	err := db.pool.QueryRow(ctx, `
		SELECT external_msg_id FROM external_messages WHERE account_id = $1 AND external_chat_id = $2 AND seq = $3`,
		r.account.ID, h.ExternalChat, h.Seq).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return db.setOutbox(ctx, []int64{h.ID}, "cancelled", "", time.Time{})
	}
	if err != nil {
		return fmt.Errorf("bridge: message seen: %w", err)
	}
	if err := w.ReadMentions(ctx, r.acct, h.ExternalChat, []string{id}); err != nil {
		return r.settleCall(ctx, []*outboxRow{h}, err)
	}
	return db.setOutbox(ctx, []int64{h.ID}, "sent", "", time.Time{})
}
