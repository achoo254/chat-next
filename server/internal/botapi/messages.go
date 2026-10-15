package botapi

import (
	"context"
	"net/http"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/botadmin"
	"app.local/server/internal/botapi/wire"
	"app.local/server/internal/chat"
)

// Message methods besides sending text (botapi.go): edit, delete, forward,
// copy, reactions and pins. Each runs the chat core's path with the bot as
// the actor, so membership, permissions, consent and blocks apply as for a
// person; the bot's tier replaces the per-user rate limits.

// seqsMax bounds the messages of one delete or forward.
const seqsMax = 100

type editRequest struct {
	ChatID             int64             `json:"chat_id"`
	Seq                int64             `json:"seq"`
	Text               *string           `json:"text"`
	Entities           []wire.Entity     `json:"entities"`
	ParseMode          string            `json:"parse_mode"`
	ReplyMarkup        *wire.ReplyMarkup `json:"reply_markup"`
	DisableLinkPreview bool              `json:"disable_link_preview"`
}

// checkMessage checks the (chat_id, seq) a method is about.
func checkMessage(chatID, seq int64) error {
	if err := checkID("chat_id", chatID); err != nil {
		return err
	}
	return checkID("seq", seq)
}

// editMessage replaces the text (caption) of one of the bot's messages;
// a reply_markup given replaces the inline keyboard, none keeps it.
func (s *Service) editMessage(ctx context.Context, r *http.Request, bot *botadmin.Bot) (any, error) {
	var req editRequest
	if err := decode(r, &req, false); err != nil {
		return nil, err
	}
	if err := checkMessage(req.ChatID, req.Seq); err != nil {
		return nil, err
	}
	if req.Text == nil {
		return nil, errBadRequest("text is required (messages:editMarkup changes only the keyboard)")
	}
	text, ents, err := s.parseText(*req.Text, req.Entities, req.ParseMode)
	if err != nil {
		return nil, err
	}
	edit := chat.BotEdit{ChatID: req.ChatID, Seq: req.Seq, Text: &text, Entities: ents, NoLinkPreview: req.DisableLinkPreview}
	if req.ReplyMarkup != nil {
		if edit.Markup, err = inlineMarkup(req.ReplyMarkup); err != nil {
			return nil, err
		}
		edit.SetMarkup = true
	}
	return s.edit(ctx, bot, edit)
}

type editMarkupRequest struct {
	ChatID      int64             `json:"chat_id"`
	Seq         int64             `json:"seq"`
	ReplyMarkup *wire.ReplyMarkup `json:"reply_markup"`
}

// editMarkup replaces the inline keyboard of one of the bot's messages;
// without reply_markup the keyboard is removed. It is not an edit for the
// chat (no "edited" mark).
func (s *Service) editMarkup(ctx context.Context, r *http.Request, bot *botadmin.Bot) (any, error) {
	var req editMarkupRequest
	if err := decode(r, &req, false); err != nil {
		return nil, err
	}
	if err := checkMessage(req.ChatID, req.Seq); err != nil {
		return nil, err
	}
	edit := chat.BotEdit{ChatID: req.ChatID, Seq: req.Seq, SetMarkup: true}
	if req.ReplyMarkup != nil {
		var err error
		if edit.Markup, err = inlineMarkup(req.ReplyMarkup); err != nil {
			return nil, err
		}
	}
	return s.edit(ctx, bot, edit)
}

func (s *Service) edit(ctx context.Context, bot *botadmin.Bot, edit chat.BotEdit) (any, error) {
	if err := s.allowSend(bot, edit.ChatID); err != nil {
		return nil, err
	}
	m, err := s.chat.EditBotMessage(ctx, bot.ID, edit)
	if err != nil {
		return nil, err
	}
	return s.messageResult(ctx, bot, m)
}

// inlineMarkup maps a keyboard that may be set on a sent message: an
// inline keyboard only.
func inlineMarkup(m *wire.ReplyMarkup) (*appv1.ReplyMarkup, error) {
	if len(m.InlineKeyboard) == 0 || len(m.Keyboard) > 0 || m.RemoveKeyboard {
		return nil, errBadRequest("a sent message takes an inline_keyboard only")
	}
	markup, err := wire.ToMarkup(m)
	if err != nil {
		return nil, errBadRequest("%v", err)
	}
	return markup, nil
}

type deleteRequest struct {
	ChatID int64   `json:"chat_id"`
	Seqs   []int64 `json:"seqs"`
}

// deleteMessages deletes messages for everyone: the bot's own at any time,
// others' where the bot is an admin (and in private chats, as either side
// may). Messages it may not delete stay; when none of them may be deleted
// the answer is 403.
func (s *Service) deleteMessages(ctx context.Context, r *http.Request, bot *botadmin.Bot) (any, error) {
	var req deleteRequest
	if err := decode(r, &req, false); err != nil {
		return nil, err
	}
	if err := checkID("chat_id", req.ChatID); err != nil {
		return nil, err
	}
	if err := checkSeqs(req.Seqs); err != nil {
		return nil, err
	}
	if _, err := s.chat.DeleteMessages(ctx, bot.ID, req.ChatID, req.Seqs, true); err != nil {
		return nil, err
	}
	return true, nil
}

func checkSeqs(seqs []int64) error {
	if len(seqs) == 0 || len(seqs) > seqsMax {
		return errBadRequest("seqs must hold 1 to %d messages", seqsMax)
	}
	for _, seq := range seqs {
		if err := checkID("seqs[]", seq); err != nil {
			return err
		}
	}
	return nil
}

type forwardRequest struct {
	FromChatID int64   `json:"from_chat_id"`
	Seqs       []int64 `json:"seqs"`
	ChatID     int64   `json:"chat_id"`
	TopicID    int64   `json:"topic_id"`
	RandomIDs  []int64 `json:"random_ids"`
}

// forwardMessages forwards messages of a chat the bot is in (and can see)
// with a forward header, in seq order.
func (s *Service) forwardMessages(ctx context.Context, r *http.Request, bot *botadmin.Bot) (any, error) {
	var req forwardRequest
	if err := decode(r, &req, false); err != nil {
		return nil, err
	}
	if err := checkID("from_chat_id", req.FromChatID); err != nil {
		return nil, err
	}
	if err := checkID("chat_id", req.ChatID); err != nil {
		return nil, err
	}
	if err := checkSeqs(req.Seqs); err != nil {
		return nil, err
	}
	if len(req.RandomIDs) != 0 && len(req.RandomIDs) != len(req.Seqs) {
		return nil, errBadRequest("random_ids must have one id per seq")
	}
	for _, id := range req.RandomIDs {
		if err := checkRandomID(id); err != nil {
			return nil, err
		}
	}
	if err := s.allowSend(bot, req.ChatID); err != nil {
		return nil, err
	}
	resp, err := s.chat.ForwardMessages(ctx, bot.ID, &appv1.ForwardMessagesRequest{
		FromChatId: req.FromChatID, Seqs: req.Seqs, ToChatId: req.ChatID, ToTopicId: req.TopicID, RandomIds: req.RandomIDs,
	})
	if err != nil {
		return nil, err
	}
	return s.messagesResult(ctx, bot, req.ChatID, resp.GetMessages())
}

type copyRequest struct {
	FromChatID int64         `json:"from_chat_id"`
	Seq        int64         `json:"seq"`
	ChatID     int64         `json:"chat_id"`
	TopicID    int64         `json:"topic_id"`
	Text       *string       `json:"text"`
	Entities   []wire.Entity `json:"entities"`
	ParseMode  string        `json:"parse_mode"`
	ReplyToSeq int64         `json:"reply_to_seq"`
	RandomID   int64         `json:"random_id"`
}

// copyMessage posts the content of a message the bot can see without a
// forward header; text replaces the text or caption.
func (s *Service) copyMessage(ctx context.Context, r *http.Request, bot *botadmin.Bot) (any, error) {
	var req copyRequest
	if err := decode(r, &req, false); err != nil {
		return nil, err
	}
	for _, f := range []struct {
		name string
		id   int64
	}{{"from_chat_id", req.FromChatID}, {"seq", req.Seq}, {"chat_id", req.ChatID}} {
		if err := checkID(f.name, f.id); err != nil {
			return nil, err
		}
	}
	if err := checkRandomID(req.RandomID); err != nil {
		return nil, err
	}
	out := &appv1.CopyMessageRequest{
		FromChatId: req.FromChatID, Seq: req.Seq, ToChatId: req.ChatID, ToTopicId: req.TopicID, ReplyToSeq: req.ReplyToSeq,
		RandomId: req.RandomID,
	}
	if req.Text != nil {
		text, ents, err := s.parseText(*req.Text, req.Entities, req.ParseMode)
		if err != nil {
			return nil, err
		}
		out.Text, out.Entities = &text, ents
	} else if len(req.Entities) > 0 || req.ParseMode != "" {
		return nil, errBadRequest("entities and parse_mode go with text")
	}
	if err := s.allowSend(bot, req.ChatID); err != nil {
		return nil, err
	}
	resp, err := s.chat.CopyMessage(ctx, bot.ID, out)
	if err != nil {
		return nil, err
	}
	return s.messageResult(ctx, bot, resp.GetMessage())
}

type reactRequest struct {
	ChatID int64  `json:"chat_id"`
	Seq    int64  `json:"seq"`
	Emoji  string `json:"emoji"`
}

// react sets the bot's reaction on a message (one emoji), or removes it
// with an empty emoji.
func (s *Service) react(ctx context.Context, r *http.Request, bot *botadmin.Bot) (any, error) {
	var req reactRequest
	if err := decode(r, &req, false); err != nil {
		return nil, err
	}
	if err := checkMessage(req.ChatID, req.Seq); err != nil {
		return nil, err
	}
	if _, err := s.chat.SetReaction(ctx, bot.ID, req.ChatID, req.Seq, req.Emoji); err != nil {
		return nil, err
	}
	return true, nil
}

type pinRequest struct {
	ChatID int64 `json:"chat_id"`
	Seq    int64 `json:"seq"`
}

// pin pins a message (with the permission to pin; it posts the "pinned"
// service message) and unpin unpins it.
func (s *Service) pin(ctx context.Context, r *http.Request, bot *botadmin.Bot) (any, error) {
	return s.pinOrUnpin(ctx, r, bot, true)
}

func (s *Service) unpin(ctx context.Context, r *http.Request, bot *botadmin.Bot) (any, error) {
	return s.pinOrUnpin(ctx, r, bot, false)
}

func (s *Service) pinOrUnpin(ctx context.Context, r *http.Request, bot *botadmin.Bot, pin bool) (any, error) {
	var req pinRequest
	if err := decode(r, &req, false); err != nil {
		return nil, err
	}
	if err := checkMessage(req.ChatID, req.Seq); err != nil {
		return nil, err
	}
	var err error
	if pin {
		if err = s.allowSend(bot, req.ChatID); err != nil {
			return nil, err
		}
		_, err = s.chat.PinMessage(ctx, bot.ID, req.ChatID, req.Seq)
	} else {
		_, err = s.chat.UnpinMessage(ctx, bot.ID, req.ChatID, req.Seq)
	}
	if err != nil {
		return nil, err
	}
	return true, nil
}

// messagesResult renders messages the bot posted into chatID.
func (s *Service) messagesResult(ctx context.Context, bot *botadmin.Bot, chatID int64, list []*appv1.Message) (any, error) {
	c, users, err := s.chat.GetChat(ctx, bot.ID, chatID)
	if err != nil {
		return nil, err
	}
	index := wire.IndexUsers(append(users, botUser(bot)))
	rendered := wire.FromChat(c, index)
	out := make([]wire.Message, 0, len(list))
	for _, m := range list {
		out = append(out, wire.FromMessage(m, rendered, index))
	}
	return out, nil
}
