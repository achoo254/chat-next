package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// ChatsHiddenFromAI returns the chats of tenantID that userID hid from AI
// (chat_members.hidden_from_ai), as a set. A chat the user left stays hidden.
func (s *Store) ChatsHiddenFromAI(ctx context.Context, tenantID string, userID int64) (map[int64]bool, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT m.chat_id FROM chat_members m JOIN chats c ON c.id = m.chat_id
		WHERE m.user_id = $2 AND m.hidden_from_ai AND c.tenant_id = $1`, tenantID, userID)
	if err != nil {
		return nil, fmt.Errorf("store: chats hidden from AI: %w", err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return nil, fmt.Errorf("store: chats hidden from AI: %w", err)
	}
	out := make(map[int64]bool, len(ids))
	for _, id := range ids {
		out[id] = true
	}
	return out, nil
}

// IncomingHookChat returns the chat an incoming webhook of tenantID posts in;
// ok is false when there is no such hook.
func (s *Store) IncomingHookChat(ctx context.Context, tenantID, hookID string) (chatID int64, ok bool, err error) {
	err = s.pool.QueryRow(ctx, `SELECT chat_id FROM incoming_hooks WHERE id = $1 AND tenant_id = $2`, hookID, tenantID).Scan(&chatID)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, fmt.Errorf("store: incoming hook chat: %w", err)
	}
	return chatID, true, nil
}

// BotUpdateChats returns the chats of the listed updates of a bot of
// tenantID; unknown updates add nothing.
func (s *Store) BotUpdateChats(ctx context.Context, tenantID string, botID int64, updateIDs []int64) ([]int64, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT DISTINCT u.chat_id FROM bot_updates u JOIN users b ON b.id = u.bot_id
		WHERE u.bot_id = $2 AND u.update_id = ANY($3) AND b.tenant_id = $1`, tenantID, botID, updateIDs)
	if err != nil {
		return nil, fmt.Errorf("store: bot update chats: %w", err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return nil, fmt.Errorf("store: bot update chats: %w", err)
	}
	return ids, nil
}
