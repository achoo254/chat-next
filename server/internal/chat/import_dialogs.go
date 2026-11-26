package chat

import (
	"context"
	"fmt"
	"time"

	appv1 "app.local/server/gen/app/v1"
)

// The state of the chat in the owner's own list (mute, pinned, marked unread), as
// the other app says it is. Like SetPinned these ask for no right and post no
// service message, and they report whether anything changed, so a state the other
// app repeats is not written again.

// SetOwnerMute sets when the owner's notifications of the chat come back (0 for
// not muted, 2147483647 for good).
func (it *ImportTx) SetOwnerMute(ctx context.Context, until int64) (bool, error) {
	if until < 0 {
		until = 0
	}
	until = min(until, muteForever)
	var current int64
	if err := it.t.tx.QueryRow(ctx, `SELECT mute_until FROM chat_members WHERE chat_id = $1 AND user_id = $2 AND left_at IS NULL`,
		it.c.ID, it.owner).Scan(&current); isNoRows(err) {
		return false, nil
	} else if err != nil {
		return false, fmt.Errorf("chat: owner mute: %w", err)
	}
	now := time.Now()
	if activeMute(current, now) == activeMute(until, now) {
		return false, nil
	}
	if _, err := it.t.tx.Exec(ctx, `UPDATE chat_members SET mute_until = $3 WHERE chat_id = $1 AND user_id = $2`, it.c.ID, it.owner, until); err != nil {
		return false, fmt.Errorf("chat: set owner mute: %w", err)
	}
	ev := it.t.event(kindDialogMute, it.c.ID, it.owner)
	it.t.toUsers(ev, []int64{it.owner}, &appv1.Update{Kind: &appv1.Update_DialogMute{DialogMute: &appv1.UpdateDialogMute{ChatId: it.c.ID, MuteUntil: until}}})
	return true, nil
}

// SetOwnerUnreadMark sets the owner's unread mark of the chat.
func (it *ImportTx) SetOwnerUnreadMark(ctx context.Context, unread bool) (bool, error) {
	var current bool
	if err := it.t.tx.QueryRow(ctx, `SELECT unread_mark FROM chat_members WHERE chat_id = $1 AND user_id = $2 AND left_at IS NULL`,
		it.c.ID, it.owner).Scan(&current); isNoRows(err) {
		return false, nil
	} else if err != nil {
		return false, fmt.Errorf("chat: owner unread mark: %w", err)
	}
	if current == unread {
		return false, nil
	}
	if err := it.t.setUnreadMark(ctx, it.c.ID, it.owner, unread); err != nil {
		return false, err
	}
	return true, nil
}

// HoldOwnerPins makes the owner's own pin and unpin in Chat wait until this transaction
// ends. Chat changes mute, unread mark and info under the lock of the chat, which this
// transaction already holds, but pins under the owner's pin lock only: once that is held
// too, a check of what Chat queued sees every change it made before, and none comes in
// between the check and what this transaction writes.
func (it *ImportTx) HoldOwnerPins(ctx context.Context) error {
	return lockPins(ctx, it.t, it.owner)
}

// SetOwnerDialogPinned pins or unpins the chat in the owner's list. Pinning past
// the limit of pinned chats is refused with a precondition error the caller logs
// and goes on from: the other app may allow more than Chat does.
func (it *ImportTx) SetOwnerDialogPinned(ctx context.Context, pinned bool) (bool, error) {
	if err := lockPins(ctx, it.t, it.owner); err != nil {
		return false, err
	}
	var rank *int32
	if err := it.t.tx.QueryRow(ctx, `SELECT pin_rank FROM chat_members WHERE chat_id = $1 AND user_id = $2 AND left_at IS NULL`,
		it.c.ID, it.owner).Scan(&rank); isNoRows(err) {
		return false, nil
	} else if err != nil {
		return false, fmt.Errorf("chat: owner pin: %w", err)
	}
	if (rank != nil) == pinned {
		return false, nil
	}
	if pinned {
		var count int
		var top int32
		if err := it.t.tx.QueryRow(ctx, `
			SELECT count(*), coalesce(max(m.pin_rank), 0) FROM chat_members m
			WHERE m.user_id = $1 AND m.pin_rank IS NOT NULL AND m.left_at IS NULL`, it.owner).Scan(&count, &top); err != nil {
			return false, fmt.Errorf("chat: count pinned dialogs: %w", err)
		}
		if count >= pinnedDialogsMax {
			return false, errPrecondition("pinned_dialogs_limit: at most %d chats can be pinned", pinnedDialogsMax)
		}
		if _, err := it.t.tx.Exec(ctx, `UPDATE chat_members SET pin_rank = $3 WHERE chat_id = $1 AND user_id = $2`, it.c.ID, it.owner, top+1); err != nil {
			return false, fmt.Errorf("chat: pin dialog: %w", err)
		}
	} else if _, err := it.t.tx.Exec(ctx, `UPDATE chat_members SET pin_rank = NULL WHERE chat_id = $1 AND user_id = $2`, it.c.ID, it.owner); err != nil {
		return false, fmt.Errorf("chat: unpin dialog: %w", err)
	}
	if _, err := it.t.s.announcePins(ctx, it.t, it.owner); err != nil {
		return false, err
	}
	return true, nil
}

// MarkOwnerTopicRead moves the owner's read position of one topic of a forum up to upToSeq,
// as the other app says they read that topic there. It never moves back. It reports whether
// the position moved; the owner's sessions then get the topic's new count.
func (it *ImportTx) MarkOwnerTopicRead(ctx context.Context, topicID, upToSeq int64) (bool, error) {
	upToSeq = min(upToSeq, it.c.LastSeq)
	if upToSeq <= 0 || !it.c.Forum {
		return false, nil
	}
	tag, err := it.t.tx.Exec(ctx, `
		INSERT INTO chat_read_states (chat_id, user_id, topic_id, read_inbox_max_seq) VALUES ($1, $2, $3, $4)
		ON CONFLICT (chat_id, user_id, topic_id) DO UPDATE
			SET read_inbox_max_seq = excluded.read_inbox_max_seq, updated_at = now()
			WHERE chat_read_states.read_inbox_max_seq < excluded.read_inbox_max_seq`, it.c.ID, it.owner, topicID, upToSeq)
	if err != nil {
		return false, fmt.Errorf("chat: owner topic read position: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return false, nil
	}
	_, m, err := it.t.s.chatFor(ctx, it.t.tx, it.c.ID, it.owner, false)
	if err != nil {
		return false, fmt.Errorf("chat: import owner member: %w", err)
	}
	inbox := &appv1.UpdateRead{ChatId: it.c.ID, MaxSeq: upToSeq, TopicId: topicID}
	ev := it.t.event(kindRead, it.c.ID, it.owner)
	it.t.toUsers(ev, []int64{it.owner}, &appv1.Update{Kind: &appv1.Update_Read{Read: inbox}})
	it.t.beforeWrite = append(it.t.beforeWrite, func(ctx context.Context) error {
		rs, err := it.t.s.readState(ctx, it.t.tx, it.c, m)
		if err != nil {
			return err
		}
		inbox.UnreadCount, inbox.UnreadMentionsCount, inbox.TopSeq = rs.unread, rs.mentions, rs.topSeq
		if it.c.SyncMode == syncLarge {
			inbox.ChatPts = rs.chatPts
		}
		n, err := it.t.s.topicUnread(ctx, it.t.tx, it.c.ID, m, topicID)
		inbox.TopicUnreadCount = n
		return err
	})
	return true, nil
}

// MarkOwnerRead moves the owner's read position of the chat up to upToSeq, as the other app
// says they read there (on another device). It never moves back and does not go past the newest
// message. It reports whether the position moved.
func (it *ImportTx) MarkOwnerRead(ctx context.Context, upToSeq int64) (bool, error) {
	upToSeq = min(upToSeq, it.c.LastSeq)
	if upToSeq <= 0 {
		return false, nil
	}
	tag, err := it.t.tx.Exec(ctx, `
		INSERT INTO chat_read_states (chat_id, user_id, topic_id, read_inbox_max_seq) VALUES ($1, $2, 0, $3)
		ON CONFLICT (chat_id, user_id, topic_id) DO UPDATE
			SET read_inbox_max_seq = excluded.read_inbox_max_seq, updated_at = now()
			WHERE chat_read_states.read_inbox_max_seq < excluded.read_inbox_max_seq`, it.c.ID, it.owner, upToSeq)
	if err != nil {
		return false, fmt.Errorf("chat: owner read position: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return false, nil
	}
	return true, it.tellOwnerRead(ctx)
}
