package chat

import (
	"context"
	"errors"
	"fmt"

	appv1 "app.local/server/gen/app/v1"
)

// The tenant's assistant bot (botadmin.EnsureSystemBot) gets a private chat
// with every user, without a message: the user sees the bot's profile and
// "Bắt đầu" and the bot writes only after that (consent as for any bot).

// SetSystemBot names the tenant's assistant bot; 0 turns the assistant
// chat off.
func (s *Service) SetSystemBot(botID int64) {
	s.systemBot.Store(botID)
}

// SystemBot returns the tenant's assistant bot, 0 when there is none.
func (s *Service) SystemBot() int64 {
	return s.systemBot.Load()
}

// EnsureSystemBotChat gives me a private chat with the assistant the first
// time (an account's first start, or the first start of an older account
// after the assistant was added). The chat is created empty and the user
// gets a member_added update, so it shows on every session at once; no
// message is sent. A chat the user deleted is not brought back. Bots get
// none.
func (s *Service) EnsureSystemBotChat(ctx context.Context, me int64) error {
	bot := s.SystemBot()
	if bot == 0 || bot == me {
		return nil
	}
	low, high := min(me, bot), max(me, bot)
	var exists bool
	if err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM private_chats WHERE tenant_id = $1 AND user_low = $2 AND user_high = $3)
			OR EXISTS (SELECT 1 FROM users WHERE id = $4 AND is_bot)`,
		s.cfg.TenantID, low, high, me).Scan(&exists); err != nil {
		return fmt.Errorf("chat: find assistant chat: %w", err)
	}
	if exists {
		return nil
	}
	_, err := s.inTx(ctx, func(t *txn) error {
		chatID, err := s.newChatID(ctx, t.tx)
		if err != nil {
			return err
		}
		if err := s.insertChat(ctx, t, &chatRow{ID: chatID, Type: typePrivate, CreatorID: me, DefaultPerms: privatePerms}); err != nil {
			return err
		}
		tag, err := t.tx.Exec(ctx, `
			INSERT INTO private_chats (tenant_id, user_low, user_high, chat_id) VALUES ($1, $2, $3, $4)
			ON CONFLICT DO NOTHING`, s.cfg.TenantID, low, high, chatID)
		if err != nil {
			return fmt.Errorf("chat: create assistant chat: %w", err)
		}
		if tag.RowsAffected() == 0 {
			// A concurrent start created it.
			return errAssistantChatExists
		}
		if _, err := t.tx.Exec(ctx, `
			INSERT INTO chat_members (chat_id, user_id, role) SELECT $1, u, 'member' FROM unnest($2::bigint[]) u`,
			chatID, []int64{low, high}); err != nil {
			return fmt.Errorf("chat: add assistant chat members: %w", err)
		}
		if _, err := t.tx.Exec(ctx, `UPDATE chats SET member_count = 2 WHERE id = $1`, chatID); err != nil {
			return fmt.Errorf("chat: assistant chat member count: %w", err)
		}
		ev := t.event(kindMemberAdded, chatID, me)
		t.toUsers(ev, []int64{me}, &appv1.Update{Kind: &appv1.Update_MemberAdded{MemberAdded: &appv1.UpdateMemberAdded{
			ChatId: chatID, UserIds: []int64{me}, InviterId: me,
		}}})
		return nil
	})
	if errors.Is(err, errAssistantChatExists) {
		return nil
	}
	return err
}

// errAssistantChatExists rolls back a creation that lost a race.
var errAssistantChatExists = errors.New("chat: assistant chat already exists")

// SystemBotNoticeChat returns the chat of the assistant with userID for a
// moderation notice, creating it when the user never had one, and records
// the notice as consent (source "notice") so the assistant may write even
// to a user who never pressed Start. 0 when there is no assistant.
func (s *Service) SystemBotNoticeChat(ctx context.Context, userID int64) (int64, error) {
	bot := s.SystemBot()
	if bot == 0 || bot == userID {
		return 0, nil
	}
	if err := s.EnsureSystemBotChat(ctx, userID); err != nil {
		return 0, err
	}
	var chatID int64
	err := s.pool.QueryRow(ctx, `SELECT chat_id FROM private_chats WHERE tenant_id = $1 AND user_low = $2 AND user_high = $3`,
		s.cfg.TenantID, min(userID, bot), max(userID, bot)).Scan(&chatID)
	if isNoRows(err) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("chat: find assistant chat: %w", err)
	}
	if err := recordConsent(ctx, s.pool, bot, userID, ConsentNotice); err != nil {
		return 0, err
	}
	return chatID, nil
}
