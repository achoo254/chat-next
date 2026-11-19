package chat

import (
	"context"
	"fmt"

	appv1 "app.local/server/gen/app/v1"
)

// ImportedReaction is the reaction of a person of the other app (their puppet
// user, or the owner) to a message.
type ImportedReaction struct {
	UserID int64
	Emoji  string
}

// SetReactions makes the reactions of the message at seq what the other app says.
// The ones listed are set; with complete, the puppets not listed lose theirs, as does
// the owner unless keepOwner. keepOwner leaves the owner's reaction as it is (the
// other app did not say it, or Chat has a change of it waiting to go out). Users who
// are not puppets keep theirs: the other app does not know them.
//
// Like SetPinned it asks for no right and posts no service message. An emoji Chat
// does not take is skipped. It reports whether anything changed: false when the
// message is gone, is a service message, or already has these reactions.
func (it *ImportTx) SetReactions(ctx context.Context, seq int64, want []ImportedReaction, complete, keepOwner bool) (bool, error) {
	m, err := it.t.s.liveMessage(ctx, it.t.tx, it.c.ID, seq)
	if isNotFound(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if isService(m) {
		return false, nil
	}
	changed := false
	listed := make([]int64, 0, len(want))
	for _, r := range want {
		if r.UserID == it.owner && keepOwner {
			continue
		}
		listed = append(listed, r.UserID)
		if !validEmoji(r.Emoji) {
			continue
		}
		tag, err := it.t.tx.Exec(ctx, `
			INSERT INTO message_reactions (chat_id, seq, user_id, emoji) VALUES ($1, $2, $3, $4)
			ON CONFLICT (chat_id, seq, user_id) DO UPDATE SET emoji = excluded.emoji, created_at = now()
			WHERE message_reactions.emoji <> excluded.emoji`, it.c.ID, seq, r.UserID, r.Emoji)
		if err != nil {
			return false, fmt.Errorf("chat: import reaction: %w", err)
		}
		if tag.RowsAffected() > 0 {
			changed = true
		}
	}
	if complete {
		tag, err := it.t.tx.Exec(ctx, `
			DELETE FROM message_reactions r WHERE r.chat_id = $1 AND r.seq = $2 AND NOT (r.user_id = ANY($3))
			AND ((r.user_id = $4 AND NOT $5) OR EXISTS (SELECT 1 FROM users u WHERE u.id = r.user_id AND u.external_source IS NOT NULL))`,
			it.c.ID, seq, listed, it.owner, keepOwner)
		if err != nil {
			return false, fmt.Errorf("chat: drop imported reactions: %w", err)
		}
		if tag.RowsAffected() > 0 {
			changed = true
		}
	}
	if !changed {
		return false, nil
	}
	members, err := it.t.fanoutSeeing(ctx, it.c, seq)
	if err != nil {
		return false, err
	}
	ev := it.t.event(kindReaction, it.c.ID, it.owner)
	if err := it.t.toChat(ctx, ev, it.c, members, &appv1.Update{Kind: &appv1.Update_Reaction{Reaction: &appv1.UpdateReaction{
		ChatId: it.c.ID, Seq: seq,
	}}}); err != nil {
		return false, err
	}
	return true, nil
}
