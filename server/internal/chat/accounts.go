package chat

import (
	"context"
	"fmt"

	appv1 "app.local/server/gen/app/v1"
	"github.com/jackc/pgx/v5"
)

// The chat side of deleting an account (package privacy runs the rest):
// what blocks it, telling chat partners the account changed, and leaving
// every chat when the account is erased.

// OwnedChats lists the groups and channels me owns, oldest first: deleting
// the account is refused while there is one.
func (s *Service) OwnedChats(ctx context.Context, me int64) ([]*appv1.OwnedChat, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT c.id, c.title, c.type = 'channel', c.member_count FROM chat_members m JOIN chats c ON c.id = m.chat_id
		WHERE m.user_id = $1 AND m.left_at IS NULL AND m.role = 'owner' AND c.type IN ('group', 'channel')
			AND c.deleted_at IS NULL AND c.tenant_id = $2
		ORDER BY c.created_at, c.id`, me, s.cfg.TenantID)
	if err != nil {
		return nil, fmt.Errorf("chat: owned chats: %w", err)
	}
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (*appv1.OwnedChat, error) {
		c := &appv1.OwnedChat{}
		err := r.Scan(&c.ChatId, &c.Title, &c.IsChannel, &c.MemberCount)
		return c, err
	})
	if err != nil {
		return nil, fmt.Errorf("chat: owned chats: %w", err)
	}
	return list, nil
}

// privatePeers returns the private chats of userID (not the saved chat)
// with the other participant of each.
func (s *Service) privatePeers(ctx context.Context, q querier, userID int64) (map[int64]int64, error) {
	rows, err := q.Query(ctx, `
		SELECT p.chat_id, CASE WHEN p.user_low = $1 THEN p.user_high ELSE p.user_low END
		FROM private_chats p JOIN chats c ON c.id = p.chat_id
		WHERE p.tenant_id = $2 AND (p.user_low = $1 OR p.user_high = $1) AND p.user_low <> p.user_high
			AND c.deleted_at IS NULL`, userID, s.cfg.TenantID)
	if err != nil {
		return nil, fmt.Errorf("chat: private chats: %w", err)
	}
	out := map[int64]int64{}
	for rows.Next() {
		var chatID, peer int64
		if err := rows.Scan(&chatID, &peer); err != nil {
			rows.Close()
			return nil, fmt.Errorf("chat: private chats: %w", err)
		}
		out[chatID] = peer
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("chat: private chats: %w", err)
	}
	return out, nil
}

// AnnounceUserChanged tells the other participant of every private chat of
// userID that the account changed (it waits for deletion, was restored or
// was erased): each gets chat_updated, which carries the user as they see
// it now. Members of shared groups learn it the next time the user comes
// with an update or a lookup.
func (s *Service) AnnounceUserChanged(ctx context.Context, userID int64) error {
	_, err := s.inTx(ctx, func(t *txn) error {
		peers, err := s.privatePeers(ctx, t.tx, userID)
		if err != nil {
			return err
		}
		for chatID, peer := range peers {
			t.announceChatTo(chatID, userID, peer)
		}
		return nil
	})
	return err
}

// announceChatTo queues chat_updated of chatID for user (rendered for them
// on delivery).
func (t *txn) announceChatTo(chatID, actor, user int64) {
	ev := t.event(kindChatUpdated, chatID, actor)
	t.toUsers(ev, []int64{user}, &appv1.Update{Kind: &appv1.Update_ChatUpdated{ChatUpdated: &appv1.UpdateChatUpdated{
		Chat: &appv1.Chat{Id: chatID},
	}}})
}

// LeaveAllChats is the chat part of erasing an account. userID leaves
// every group and channel without a service message (like moderation);
// where it is the owner, the chat passes to the longest-serving admin, else
// to the longest-serving member who is a person, and a chat with nobody
// else left is deleted. Private chats whose other participant is a bot or
// an erased account are deleted, as is the saved chat ("Cloud của tôi"),
// and their messages purged later (purgeDeletedChats); the other private
// chats stay for the person who is left, who gets chat_updated. The
// messages userID sent elsewhere stay. Each chat is its own transaction,
// so a failure part-way is resumed by the next call.
func (s *Service) LeaveAllChats(ctx context.Context, userID int64) error {
	rows, err := s.pool.Query(ctx, `
		SELECT m.chat_id FROM chat_members m JOIN chats c ON c.id = m.chat_id
		WHERE m.user_id = $1 AND m.left_at IS NULL AND c.type IN ('group', 'channel') AND c.deleted_at IS NULL
			AND c.tenant_id = $2
		ORDER BY m.chat_id`, userID, s.cfg.TenantID)
	if err != nil {
		return fmt.Errorf("chat: chats to leave: %w", err)
	}
	groups, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return fmt.Errorf("chat: chats to leave: %w", err)
	}
	for _, chatID := range groups {
		if _, err := s.inTx(ctx, func(t *txn) error { return t.leaveForErasure(ctx, chatID, userID) }); err != nil {
			return err
		}
	}

	if saved, err := s.savedChatID(ctx, s.pool, userID); err != nil {
		return err
	} else if saved != 0 {
		if err := s.deleteChatForErasure(ctx, saved, userID); err != nil {
			return err
		}
	}
	peers, err := s.privatePeers(ctx, s.pool, userID)
	if err != nil {
		return err
	}
	for chatID, peer := range peers {
		var keep bool
		if err := s.pool.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM users WHERE id = $1 AND NOT is_bot AND deleted_at IS NULL)`, peer).Scan(&keep); err != nil {
			return fmt.Errorf("chat: private chat peer: %w", err)
		}
		if !keep {
			if err := s.deleteChatForErasure(ctx, chatID, userID); err != nil {
				return err
			}
			continue
		}
		if _, err := s.inTx(ctx, func(t *txn) error {
			t.announceChatTo(chatID, userID, peer)
			return nil
		}); err != nil {
			return err
		}
	}
	return nil
}

// leaveForErasure takes userID out of one group or channel, handing the
// ownership on first when needed.
func (t *txn) leaveForErasure(ctx context.Context, chatID, userID int64) error {
	c, err := scanChat(t.tx.QueryRow(ctx, `SELECT `+chatColumns+` FROM `+chatFrom+`
		WHERE c.id = $1 AND c.tenant_id = $2 AND c.deleted_at IS NULL FOR UPDATE OF c`, chatID, t.s.cfg.TenantID))
	if isNoRows(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("chat: load chat: %w", err)
	}
	m, err := t.s.memberRow(ctx, t.tx, chatID, userID)
	if isNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !m.active() {
		return nil
	}
	if m.Role == roleOwner {
		var heir int64
		err := t.tx.QueryRow(ctx, `
			SELECT m.user_id FROM chat_members m JOIN users u ON u.id = m.user_id
			WHERE m.chat_id = $1 AND m.left_at IS NULL AND m.user_id <> $2
				AND NOT u.is_bot AND u.deletion_requested_at IS NULL AND u.deleted_at IS NULL
			ORDER BY m.role = 'admin' DESC, m.joined_at, m.user_id LIMIT 1`, chatID, userID).Scan(&heir)
		switch {
		case isNoRows(err):
			// Nobody to take it over: the chat goes with its owner.
			return t.deleteChat(ctx, c, userID)
		case err != nil:
			return fmt.Errorf("chat: pick new owner: %w", err)
		}
		if err := t.setRole(ctx, c, 0, heir, roleOwner); err != nil {
			return err
		}
	}
	return t.removeMember(ctx, c, 0, userID, false)
}

// deleteChatForErasure deletes a private or saved chat of an erased
// account for both participants.
func (s *Service) deleteChatForErasure(ctx context.Context, chatID, userID int64) error {
	_, err := s.inTx(ctx, func(t *txn) error {
		c, err := scanChat(t.tx.QueryRow(ctx, `SELECT `+chatColumns+` FROM `+chatFrom+`
			WHERE c.id = $1 AND c.tenant_id = $2 AND c.deleted_at IS NULL FOR UPDATE OF c`, chatID, s.cfg.TenantID))
		if isNoRows(err) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("chat: load chat: %w", err)
		}
		return t.deleteChat(ctx, c, userID)
	})
	return err
}
