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
}

// MemberChats returns the chats among chatIDs that userID is a current
// member of (the gateway checks OpenChat with it).
func (s *Service) MemberChats(ctx context.Context, userID int64, chatIDs []int64) ([]ChatAccess, error) {
	if len(chatIDs) == 0 {
		return nil, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT c.id, c.sync_mode = 'large',
			CASE WHEN p.user_low = $1 THEN p.user_high WHEN p.user_high = $1 THEN p.user_low ELSE 0 END
		FROM chat_members m JOIN chats c ON c.id = m.chat_id LEFT JOIN private_chats p ON p.chat_id = c.id
		WHERE m.user_id = $1 AND m.left_at IS NULL AND m.chat_id = ANY($2) AND c.tenant_id = $3`,
		userID, chatIDs, s.cfg.TenantID)
	if err != nil {
		return nil, fmt.Errorf("chat: member chats: %w", err)
	}
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (ChatAccess, error) {
		var a ChatAccess
		err := r.Scan(&a.ChatID, &a.Large, &a.PeerID)
		return a, err
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
