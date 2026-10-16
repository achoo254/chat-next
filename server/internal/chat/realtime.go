package chat

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// ChatAccess is what the gateway may do with a chat a session opened.
type ChatAccess struct {
	ChatID int64
	Large  bool
	// PeerID is the other participant of a private chat.
	PeerID int64
	// CanSend: the user may post in the chat now (permissions, and in a
	// private chat the peer has not blocked them); typing requires it.
	CanSend bool
	// Blocked: a private chat whose participants block each other in either
	// direction; no typing goes either way.
	Blocked bool
}

// MemberChats returns the chats among chatIDs that userID is a current
// member of (the gateway checks OpenChat with it), with what the user may
// do there.
func (s *Service) MemberChats(ctx context.Context, userID int64, chatIDs []int64) ([]ChatAccess, error) {
	if len(chatIDs) == 0 {
		return nil, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT x.id, x.large, x.type, x.default_permissions, x.role, x.permissions, x.peer,
			EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = x.peer AND b.blocked_id = $1),
			EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = $1 AND b.blocked_id = x.peer),
			EXISTS (SELECT 1 FROM users u WHERE u.id = x.peer AND x.peer <> $1
				AND (u.deletion_requested_at IS NOT NULL OR u.deleted_at IS NOT NULL))
		FROM (
			SELECT c.id, c.sync_mode = 'large' AS large, c.type, c.default_permissions, m.role, m.permissions,
				CASE WHEN p.user_low = $1 THEN p.user_high WHEN p.user_high = $1 THEN p.user_low ELSE 0 END AS peer
			FROM chat_members m JOIN chats c ON c.id = m.chat_id LEFT JOIN private_chats p ON p.chat_id = c.id
			WHERE m.user_id = $1 AND m.left_at IS NULL AND m.chat_id = ANY($2) AND c.tenant_id = $3) x`,
		userID, chatIDs, s.cfg.TenantID)
	if err != nil {
		return nil, fmt.Errorf("chat: member chats: %w", err)
	}
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (ChatAccess, error) {
		var a ChatAccess
		c, m := &chatRow{}, &memberRow{UserID: userID}
		var defaults int32
		var perms *int32
		var peerBlockedMe, iBlocked, peerDeleted bool
		if err := r.Scan(&a.ChatID, &a.Large, &c.Type, &defaults, &m.Role, &perms, &a.PeerID, &peerBlockedMe, &iBlocked, &peerDeleted); err != nil {
			return a, err
		}
		c.DefaultPerms = uint32(defaults)
		if perms != nil {
			p := uint32(*perms)
			m.Perms = &p
		}
		a.CanSend = c.can(m, permSend) && !peerBlockedMe && !peerDeleted
		a.Blocked = peerBlockedMe || iBlocked
		return a, nil
	})
	if err != nil {
		return nil, fmt.Errorf("chat: member chats: %w", err)
	}
	return list, nil
}

// MembersAmong returns which of userIDs are current members of the chat.
func (s *Service) MembersAmong(ctx context.Context, chatID int64, userIDs []int64) ([]int64, error) {
	if len(userIDs) == 0 {
		return nil, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT user_id FROM chat_members WHERE chat_id = $1 AND user_id = ANY($2) AND left_at IS NULL`, chatID, userIDs)
	if err != nil {
		return nil, fmt.Errorf("chat: members among: %w", err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return nil, fmt.Errorf("chat: members among: %w", err)
	}
	return ids, nil
}

// PrivatePeers returns, for each private chat of userID, the other
// participant (presence goes to peers who have the chat open).
func (s *Service) PrivatePeers(ctx context.Context, userID int64) (map[int64]int64, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT chat_id, CASE WHEN user_low = $1 THEN user_high ELSE user_low END FROM private_chats
		WHERE tenant_id = $2 AND (user_low = $1 OR user_high = $1)`, userID, s.cfg.TenantID)
	if err != nil {
		return nil, fmt.Errorf("chat: private peers: %w", err)
	}
	defer rows.Close()
	out := map[int64]int64{}
	for rows.Next() {
		var chatID, peer int64
		if err := rows.Scan(&chatID, &peer); err != nil {
			return nil, fmt.Errorf("chat: private peers: %w", err)
		}
		out[chatID] = peer
	}
	return out, rows.Err()
}
