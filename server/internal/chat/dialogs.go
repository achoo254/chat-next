package chat

import (
	"context"
	"fmt"
	"slices"
	"strconv"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"github.com/jackc/pgx/v5"
)

// Per-user dialog settings and chat deletion.
const (
	// muteForever is Dialog.mute_until of a chat muted until unmuted.
	muteForever = int64(2147483647)
	// muteDurationMax bounds a timed mute.
	muteDurationMax = 366 * 24 * 60 * 60
	// pinnedDialogsMax is how many chats one user can pin.
	pinnedDialogsMax = 5
	commonPageDef    = 50
	commonPageMax    = 100
)

// activeMute is mute_until as clients see it: 0 once the mute ended.
func activeMute(until int64, now time.Time) int64 {
	if until <= now.Unix() {
		return 0
	}
	return until
}

// SetDialogMute mutes my notifications of a chat for durationSeconds, until
// unmuted (forever), or unmutes it (0, not forever). My sessions get
// dialog_mute.
func (s *Service) SetDialogMute(ctx context.Context, me, chatID int64, durationSeconds int32, forever bool) (*appv1.SetDialogMuteResponse, error) {
	if !forever && (durationSeconds < 0 || durationSeconds > muteDurationMax) {
		return nil, errInvalid("duration_seconds must be 0 to %d", muteDurationMax)
	}
	if err := s.allow(limitWrite, "write", me); err != nil {
		return nil, err
	}
	until := int64(0)
	switch {
	case forever:
		until = muteForever
	case durationSeconds > 0:
		until = min(time.Now().Unix()+int64(durationSeconds), muteForever)
	}
	t, err := s.inTx(ctx, func(t *txn) error {
		c, _, err := s.activeChatFor(ctx, t.tx, chatID, me, true)
		if err != nil {
			return err
		}
		if _, err := t.tx.Exec(ctx, `UPDATE chat_members SET mute_until = $3 WHERE chat_id = $1 AND user_id = $2`,
			c.ID, me, until); err != nil {
			return fmt.Errorf("chat: set mute: %w", err)
		}
		ev := t.event(kindDialogMute, c.ID, me)
		t.toUsers(ev, []int64{me}, &appv1.Update{Kind: &appv1.Update_DialogMute{DialogMute: &appv1.UpdateDialogMute{
			ChatId: c.ID, MuteUntil: until,
		}}})
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &appv1.SetDialogMuteResponse{MuteUntil: until, Ack: t.ack(me, chatID)}, nil
}

// lockPins serializes changes of one user's pinned chats (the limit check
// and the ranks) within the transaction. Only pin operations take it, and
// first, so it never meets the chat lock order.
func lockPins(ctx context.Context, t *txn, me int64) error {
	if _, err := t.tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('chat:dialog_pins:' || $1::bigint, 0))`, me); err != nil {
		return fmt.Errorf("chat: lock pinned dialogs: %w", err)
	}
	return nil
}

// announcePins writes my pinned chats, top first, to my log.
func (s *Service) announcePins(ctx context.Context, t *txn, me int64) ([]int64, error) {
	pinned, err := pinnedDialogs(ctx, t.tx, s.cfg.TenantID, me)
	if err != nil {
		return nil, err
	}
	ev := t.event(kindPinnedDialogs, 0, me)
	t.toUsers(ev, []int64{me}, &appv1.Update{Kind: &appv1.Update_PinnedDialogs{PinnedDialogs: &appv1.UpdatePinnedDialogs{
		ChatIds: pinned,
	}}})
	return pinned, nil
}

// SetDialogPinned pins a chat on top of my list or unpins it.
func (s *Service) SetDialogPinned(ctx context.Context, me, chatID int64, pinned bool) (*appv1.SetDialogPinnedResponse, error) {
	if err := s.allow(limitWrite, "write", me); err != nil {
		return nil, err
	}
	var list []int64
	t, err := s.inTx(ctx, func(t *txn) error {
		if err := lockPins(ctx, t, me); err != nil {
			return err
		}
		_, m, err := s.activeChatFor(ctx, t.tx, chatID, me, false)
		if err != nil {
			return err
		}
		if (m.PinRank != 0) == pinned {
			list, err = pinnedDialogs(ctx, t.tx, s.cfg.TenantID, me)
			return err
		}
		if pinned {
			var count int
			var top int32
			if err := t.tx.QueryRow(ctx, `
				SELECT count(*) FILTER (WHERE `+dialogListed+`), coalesce(max(m.pin_rank), 0)
				FROM chat_members m JOIN chats c ON c.id = m.chat_id
				WHERE m.user_id = $1 AND m.pin_rank IS NOT NULL AND m.left_at IS NULL`, me).Scan(&count, &top); err != nil {
				return fmt.Errorf("chat: count pinned dialogs: %w", err)
			}
			if count >= pinnedDialogsMax {
				return errPrecondition("pinned_dialogs_limit: at most %d chats can be pinned", pinnedDialogsMax)
			}
			if _, err := t.tx.Exec(ctx, `UPDATE chat_members SET pin_rank = $3 WHERE chat_id = $1 AND user_id = $2`,
				chatID, me, top+1); err != nil {
				return fmt.Errorf("chat: pin dialog: %w", err)
			}
		} else if _, err := t.tx.Exec(ctx, `UPDATE chat_members SET pin_rank = NULL WHERE chat_id = $1 AND user_id = $2`,
			chatID, me); err != nil {
			return fmt.Errorf("chat: unpin dialog: %w", err)
		}
		list, err = s.announcePins(ctx, t, me)
		return err
	})
	if err != nil {
		return nil, err
	}
	return &appv1.SetDialogPinnedResponse{PinnedChatIds: list, Ack: t.ack(me, 0)}, nil
}

// ReorderPinnedDialogs sets the order of my pinned chats; chatIDs must be
// exactly the pinned chats, top first.
func (s *Service) ReorderPinnedDialogs(ctx context.Context, me int64, chatIDs []int64) (*appv1.ReorderPinnedDialogsResponse, error) {
	if len(chatIDs) > pinnedDialogsMax {
		return nil, errInvalid("at most %d pinned chats", pinnedDialogsMax)
	}
	if err := s.allow(limitWrite, "write", me); err != nil {
		return nil, err
	}
	var list []int64
	t, err := s.inTx(ctx, func(t *txn) error {
		if err := lockPins(ctx, t, me); err != nil {
			return err
		}
		current, err := pinnedDialogs(ctx, t.tx, s.cfg.TenantID, me)
		if err != nil {
			return err
		}
		want, have := uniqueSorted(chatIDs), slices.Sorted(slices.Values(current))
		if len(want) != len(chatIDs) || !slices.Equal(want, have) {
			return errInvalid("chat_ids must list every pinned chat exactly once")
		}
		if slices.Equal(chatIDs, current) {
			list = current
			return nil
		}
		ranks := make([]int32, len(chatIDs))
		for i := range chatIDs {
			ranks[i] = int32(len(chatIDs) - i)
		}
		if _, err := t.tx.Exec(ctx, `
			UPDATE chat_members m SET pin_rank = x.rank FROM unnest($2::bigint[], $3::int[]) AS x(chat_id, rank)
			WHERE m.user_id = $1 AND m.chat_id = x.chat_id`, me, chatIDs, ranks); err != nil {
			return fmt.Errorf("chat: reorder pinned dialogs: %w", err)
		}
		list, err = s.announcePins(ctx, t, me)
		return err
	})
	if err != nil {
		return nil, err
	}
	return &appv1.ReorderPinnedDialogsResponse{PinnedChatIds: list, Ack: t.ack(me, 0)}, nil
}

// DeleteChat deletes a group or channel for every member (owner only), or
// removes a private chat and its history for me only.
func (s *Service) DeleteChat(ctx context.Context, me, chatID int64) (*appv1.SyncAck, error) {
	if err := s.allow(limitWrite, "write", me); err != nil {
		return nil, err
	}
	t, err := s.inTx(ctx, func(t *txn) error {
		c, m, err := s.activeChatFor(ctx, t.tx, chatID, me, true)
		if err != nil {
			return err
		}
		if c.Type == typePrivate {
			return t.clearPrivate(ctx, c, me)
		}
		if m.Role != roleOwner {
			return errDenied("only the owner deletes the chat")
		}
		return t.deleteChat(ctx, c, me)
	})
	if err != nil {
		return nil, err
	}
	return t.ack(me, chatID), nil
}

// clearPrivate hides a private chat's history from me: I see only messages
// after the newest one, nothing counts as unread, the chat leaves my list
// (and my pins) until a new message arrives, and my sessions get
// chat_deleted.
func (t *txn) clearPrivate(ctx context.Context, c *chatRow, me int64) error {
	if _, err := t.tx.Exec(ctx, `
		UPDATE chat_members SET visible_from_seq = $3 + 1, pin_rank = NULL WHERE chat_id = $1 AND user_id = $2`,
		c.ID, me, c.LastSeq); err != nil {
		return fmt.Errorf("chat: clear private chat: %w", err)
	}
	if _, err := t.tx.Exec(ctx, `
		INSERT INTO chat_read_states (chat_id, user_id, topic_id, read_inbox_max_seq) VALUES ($1, $2, 0, $3)
		ON CONFLICT (chat_id, user_id, topic_id) DO UPDATE
			SET read_inbox_max_seq = greatest(chat_read_states.read_inbox_max_seq, excluded.read_inbox_max_seq), updated_at = now()`,
		c.ID, me, c.LastSeq); err != nil {
		return fmt.Errorf("chat: clear private chat: %w", err)
	}
	ev := t.event(kindChatDeleted, c.ID, me)
	t.toUsers(ev, []int64{me}, &appv1.Update{Kind: &appv1.Update_ChatDeleted{ChatDeleted: &appv1.UpdateChatDeleted{ChatId: c.ID}}})
	return nil
}

// deleteChat deletes a locked group or channel for everyone: every current
// member gets chat_deleted in their own log, every membership (former ones
// too) and invite link goes at once, so nothing of the chat is reachable;
// purgeDeletedChats removes the messages later.
func (t *txn) deleteChat(ctx context.Context, c *chatRow, actor int64) error {
	members, err := activeMembers(ctx, t.tx, c.ID)
	if err != nil {
		return err
	}
	ev := t.event(kindChatDeleted, c.ID, actor)
	t.toUsers(ev, members, &appv1.Update{Kind: &appv1.Update_ChatDeleted{ChatDeleted: &appv1.UpdateChatDeleted{
		ChatId: c.ID, ForEveryone: true,
	}}})
	ev.Forget = members
	for _, sql := range []string{
		`DELETE FROM invite_links WHERE chat_id = $1`,
		`DELETE FROM chat_members WHERE chat_id = $1`,
		`UPDATE chats SET deleted_at = now(), member_count = 0, pinned_seq = 0, updated_at = now() WHERE id = $1`,
	} {
		if _, err := t.tx.Exec(ctx, sql, c.ID); err != nil {
			return fmt.Errorf("chat: delete chat: %w", err)
		}
	}
	t.s.logger.Info("chat deleted", "chat_id", c.ID, "actor_id", actor, "members", len(members))
	return nil
}

// purgeBatch is how many messages one purge statement removes.
const purgeBatch = 5000

// purgeDeletedChats removes the messages of deleted chats and every row
// keyed by them, in batches; it returns how many chats it finished.
func (s *Service) purgeDeletedChats(ctx context.Context) (int, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id FROM chats WHERE deleted_at IS NOT NULL AND purged_at IS NULL AND tenant_id = $1 ORDER BY deleted_at LIMIT 100`,
		s.cfg.TenantID)
	if err != nil {
		return 0, fmt.Errorf("chat: deleted chats: %w", err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return 0, fmt.Errorf("chat: deleted chats: %w", err)
	}
	done := 0
	for _, id := range ids {
		for {
			tag, err := s.pool.Exec(ctx, `
				DELETE FROM messages WHERE chat_id = $1 AND seq IN (
					SELECT seq FROM messages WHERE chat_id = $1 ORDER BY seq LIMIT $2)`, id, purgeBatch)
			if err != nil {
				return done, fmt.Errorf("chat: purge messages of chat %d: %w", id, err)
			}
			if tag.RowsAffected() < purgeBatch {
				break
			}
		}
		for _, sql := range []string{
			`DELETE FROM message_reactions WHERE chat_id = $1`,
			`DELETE FROM user_hidden_messages WHERE chat_id = $1`,
			`DELETE FROM message_mentions WHERE chat_id = $1`,
			`DELETE FROM pinned_messages WHERE chat_id = $1`,
			`DELETE FROM read_receipts WHERE chat_id = $1`,
			`DELETE FROM forum_topics WHERE chat_id = $1`,
			`DELETE FROM send_dedupe WHERE chat_id = $1`,
			`UPDATE chats SET purged_at = now() WHERE id = $1`,
		} {
			if _, err := s.pool.Exec(ctx, sql, id); err != nil {
				return done, fmt.Errorf("chat: purge chat %d: %w", id, err)
			}
		}
		done++
	}
	return done, nil
}

// GetCommonChats lists the groups userID and I are both current members of,
// and the channels where userID is a member and I am an admin.
func (s *Service) GetCommonChats(ctx context.Context, me, userID int64, cursor string, limit int32) (*appv1.GetCommonChatsResponse, error) {
	if userID <= 0 || userID == me {
		return nil, errInvalid("user_id must be another user")
	}
	if limit <= 0 {
		limit = commonPageDef
	}
	limit = min(limit, commonPageMax)
	after := int64(0)
	if cursor != "" {
		v, err := strconv.ParseInt(cursor, 10, 64)
		if err != nil || v < 0 {
			return nil, errInvalid("invalid cursor")
		}
		after = v
	}
	const common = `FROM chats c
		JOIN chat_members a ON a.chat_id = c.id AND a.user_id = $1 AND a.left_at IS NULL
		JOIN chat_members b ON b.chat_id = c.id AND b.user_id = $2 AND b.left_at IS NULL
		WHERE c.tenant_id = $3 AND c.deleted_at IS NULL
			AND (c.type = 'group' OR (c.type = 'channel' AND a.role IN ('admin', 'owner')))`
	resp := &appv1.GetCommonChatsResponse{}
	if err := s.pool.QueryRow(ctx, `SELECT count(*) `+common, me, userID, s.cfg.TenantID).Scan(&resp.Count); err != nil {
		return nil, fmt.Errorf("chat: count common chats: %w", err)
	}
	rows, err := s.pool.Query(ctx, `SELECT c.id `+common+` AND c.id > $4 ORDER BY c.id LIMIT $5`,
		me, userID, s.cfg.TenantID, after, limit+1)
	if err != nil {
		return nil, fmt.Errorf("chat: common chats: %w", err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return nil, fmt.Errorf("chat: common chats: %w", err)
	}
	if len(ids) > int(limit) {
		ids = ids[:limit]
		resp.NextCursor = strconv.FormatInt(ids[len(ids)-1], 10)
	}
	ents := newEntitySet()
	ents.addChats(me, ids...)
	rendered, err := ents.render(ctx, s.pool, s.cfg.TenantID)
	if err != nil {
		return nil, err
	}
	resp.Chats = rendered.chats[me]
	return resp, nil
}
