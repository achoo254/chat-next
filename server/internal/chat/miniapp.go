package chat

import (
	"context"
	"fmt"
	"unicode/utf8"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/miniapp"
	"google.golang.org/protobuf/proto"
)

// Mini Apps: the client opens a bot's Mini App (its main one, or the URL of
// an inline button), the user may let it message them and it may send data
// back to the bot as a message of the user.

// miniAppDataMax bounds the data a Mini App sends to its bot, in bytes.
const miniAppDataMax = 4096

// CheckMiniAppURL applies the Mini App URL rules (miniapp.URLs.Check).
func (s *Service) CheckMiniAppURL(ctx context.Context, raw string) error {
	return s.miniAppURLs.Check(ctx, s.pool, raw)
}

// MiniAppChatType checks that me may open botID's Mini App from chatID and
// returns the chat_type of its init data. Outside a chat (chatID 0, the
// bot's profile) only the main Mini App opens (url ""), as "sender". In a
// chat me must be a current member: the main Mini App needs the bot in the
// chat; a button URL must be the mini_app_url of an inline button of the
// bot's message chatID/seq that me can see.
func (s *Service) MiniAppChatType(ctx context.Context, me, botID, chatID, seq int64, url string) (string, error) {
	if botID <= 0 || botID == me {
		return "", errInvalid("bot_id is required")
	}
	if chatID == 0 {
		if seq != 0 || url != "" {
			return "", errInvalid("a Mini App button needs chat_id and seq")
		}
		return miniapp.ChatSender, nil
	}
	c, mem, err := s.activeChatFor(ctx, s.pool, chatID, me, false)
	if err != nil {
		return "", err
	}
	if url == "" {
		if seq != 0 {
			return "", errInvalid("seq is only for the Mini App of a button")
		}
		var inChat bool
		if err := s.pool.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2 AND left_at IS NULL)`,
			chatID, botID).Scan(&inChat); err != nil {
			return "", fmt.Errorf("chat: find bot member: %w", err)
		}
		if !inChat {
			return "", errInvalid("the bot is not in this chat")
		}
	} else {
		if seq <= 0 {
			return "", errInvalid("seq is required")
		}
		msg, err := s.liveMessage(ctx, s.pool, chatID, seq)
		if err != nil {
			return "", err
		}
		if !mem.sees(msg) {
			return "", errNotFound("message")
		}
		if msg.FromID != botID || !hasMiniAppButton(msg.Content, url) {
			return "", errInvalid("the message has no Mini App button of this bot with this url")
		}
	}
	switch c.Type {
	case typeGroup:
		return miniapp.ChatGroup, nil
	case typeChannel:
		return miniapp.ChatChannel, nil
	default:
		return miniapp.ChatPrivate, nil
	}
}

// hasMiniAppButton reports whether stored message content has an inline
// Mini App button with exactly url.
func hasMiniAppButton(content []byte, url string) bool {
	if len(content) == 0 {
		return false
	}
	var m appv1.Message
	if proto.Unmarshal(content, &m) != nil {
		return false
	}
	for _, row := range m.GetReplyMarkup().GetInlineKeyboard().GetRows() {
		for _, b := range row.GetButtons() {
			if a, ok := b.GetAction().(*appv1.InlineButton_MiniAppUrl); ok && a.MiniAppUrl == url {
				return true
			}
		}
	}
	return false
}

// AllowBotWrite records me's consent for a live bot to message them, with
// the source of a button press (the Mini App asked and the user agreed),
// and opens their private chat as Bắt đầu does, so the bot has a chat to
// write to (sends by user id look it up). No message is sent.
func (s *Service) AllowBotWrite(ctx context.Context, me, botID int64) error {
	if botID <= 0 || botID == me {
		return errInvalid("bot_id is required")
	}
	if err := s.allow(ctx, limitWrite, "write", me); err != nil {
		return err
	}
	ok, err := s.liveBot(ctx, s.pool, botID)
	if err != nil {
		return err
	}
	if !ok {
		return errNotFound("bot")
	}
	if _, _, err := s.CreatePrivate(ctx, me, botID); err != nil {
		return err
	}
	return recordConsent(ctx, s.pool, botID, me, ConsentButton)
}

// SendMiniAppData posts, as me, a service message carrying ActionMiniAppData
// into me's private chat with the bot (opened when needed). It goes through
// the normal send path: the send limit, the private chat rules (writing to
// the bot is consent), the outbox, realtime and the bot's message update
// (web_app_data in the Bot API).
func (s *Service) SendMiniAppData(ctx context.Context, me, botID int64, data, buttonText string) (*appv1.SendMessageResponse, error) {
	if botID <= 0 || botID == me {
		return nil, errInvalid("bot_id is required")
	}
	if data == "" || len(data) > miniAppDataMax || !utf8.ValidString(data) {
		return nil, errInvalid("data must have 1 to %d bytes of UTF-8", miniAppDataMax)
	}
	if buttonText != "" {
		if err := checkButtonText(buttonText); err != nil {
			return nil, err
		}
	}
	if err := s.allow(ctx, limitSend, "send", me); err != nil {
		return nil, err
	}
	ok, err := s.liveBot(ctx, s.pool, botID)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, errNotFound("bot")
	}
	chat, _, err := s.CreatePrivate(ctx, me, botID)
	if err != nil {
		return nil, err
	}
	return s.postText(ctx, me, textPost{
		chatID: chat.GetId(), noPreview: true,
		action: &appv1.MessageAction{Kind: &appv1.MessageAction_MiniAppData{
			MiniAppData: &appv1.ActionMiniAppData{Data: data, ButtonText: buttonText},
		}},
	})
}
