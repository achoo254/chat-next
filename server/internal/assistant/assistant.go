// Package assistant runs the tenant's official assistant bot inside the api
// process: it greets users who press "Bắt đầu" in their chat with it, gives
// a quick guide, and records what they write as feedback for the operators,
// who answer through it.
//
// The assistant is a bot like any other: botadmin.EnsureSystemBot keeps
// its account, it reads its updates with the same long poll as GET
// /bot/v1/updates (botupdates.Poll) and sends through the Bot API's
// in-process methods, so consent, privacy, blocks and rate limits apply.
// Each user gets an empty private chat with it (chat.EnsureSystemBotChat on
// every app start); the assistant writes only after the user starts it.
package assistant

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/botadmin"
	"app.local/server/internal/botapi"
	"app.local/server/internal/botapi/wire"
	"app.local/server/internal/botbulk"
	"app.local/server/internal/botupdates"
	"app.local/server/internal/brand"
	"app.local/server/internal/chat"
	"connectrpc.com/connect"
)

// Timings of the update loop.
const (
	pollTimeout = botupdates.LongPollMax
	pollBatch   = 100
	retryAfter  = 2 * time.Second
	// attemptsMax: an update that keeps failing is skipped after this
	// many tries, so it cannot stall every later one.
	attemptsMax = 3
	// pendingTTL is how long a "Gửi góp ý" / "Báo lỗi" press labels the
	// user's next message.
	pendingTTL = time.Hour
	// quoteMax bounds the quote of feedback sent from Settings in the
	// answer, in characters.
	quoteMax = 140
)

// Service is the assistant of one tenant.
type Service struct {
	chat    *chat.Service
	admin   *botadmin.Service
	updates *botupdates.Service
	api     *botapi.Service
	bulk    *botbulk.Service // announcements; nil turns them off (UseBulk)
	logger  *slog.Logger
	copy    copyText
	botID   int64

	mu sync.Mutex
	// pending is the kind the user's next message is filed as, after they
	// pressed "Gửi góp ý" or "Báo lỗi" (in memory: a restart only loses
	// the label, the message is still recorded as an idea).
	pending map[int64]pendingKind
}

type pendingKind struct {
	kind  string
	until time.Time
}

// New returns the assistant; call Ensure before Run.
func New(chatSvc *chat.Service, admin *botadmin.Service, updates *botupdates.Service, api *botapi.Service,
	names brand.Names, logger *slog.Logger) (*Service, error) {
	if chatSvc == nil || admin == nil || updates == nil || api == nil || logger == nil {
		return nil, errors.New("assistant: missing dependency")
	}
	return &Service{chat: chatSvc, admin: admin, updates: updates, api: api, logger: logger, copy: newCopy(names),
		pending: map[int64]pendingKind{}}, nil
}

// Ensure creates or updates the assistant's account and turns on the
// assistant chat of every user.
func (s *Service) Ensure(ctx context.Context) error {
	bot, err := s.admin.EnsureSystemBot(ctx, botadmin.SystemBot{
		Username: Username, Name: s.copy.name, Description: s.copy.description, About: s.copy.about, Commands: commands(),
	})
	if err != nil {
		return err
	}
	s.botID = bot.ID
	s.chat.SetSystemBot(bot.ID)
	return nil
}

// BotID is the assistant's user id (0 before Ensure).
func (s *Service) BotID() int64 {
	return s.botID
}

// Run handles the assistant's updates until ctx ends or the process shuts
// down. Updates are acknowledged once handled; a restart handles the rest
// again, and every effect is idempotent (sends carry a random_id derived
// from the update, feedback is keyed by its message).
func (s *Service) Run(ctx context.Context) {
	var offset int64
	attempts := map[int64]int{}
	for ctx.Err() == nil {
		list, err := s.updates.Poll(ctx, s.botID, offset, pollBatch, pollTimeout)
		switch {
		case errors.Is(err, botupdates.ErrUnavailable), ctx.Err() != nil:
			return
		case err != nil:
			s.logger.Error("assistant could not read its updates", "err", err)
			sleep(ctx, retryAfter)
			continue
		}
		for _, u := range list {
			if err := s.handle(ctx, u); err != nil {
				if ctx.Err() != nil {
					return
				}
				attempts[u.ID]++
				if attempts[u.ID] < attemptsMax {
					s.logger.Warn("assistant update failed; retrying", "update_id", u.ID, "kind", u.Kind, "err", err)
					sleep(ctx, retryAfter)
					break
				}
				s.logger.Error("assistant skipped an update", "update_id", u.ID, "kind", u.Kind, "err", err)
			}
			delete(attempts, u.ID)
			offset = u.ID + 1
		}
	}
}

func sleep(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

// handle reacts to one update: messages and button presses in private
// chats; everything else is ignored.
func (s *Service) handle(ctx context.Context, u botupdates.Update) error {
	switch u.Kind {
	case chat.BotUpdateMessage:
		var m wire.Message
		if err := json.Unmarshal(u.Payload, &m); err != nil {
			return fmt.Errorf("assistant: decode message: %w", err)
		}
		if m.Chat.Type != "private" || m.From == nil || m.From.IsBot {
			return nil
		}
		return s.onMessage(ctx, u.ID, &m)
	case chat.BotUpdateCallback:
		var cb wire.Callback
		if err := json.Unmarshal(u.Payload, &cb); err != nil {
			return fmt.Errorf("assistant: decode callback: %w", err)
		}
		if cb.Message.Chat.Type != "private" {
			return nil
		}
		return s.onButton(ctx, u.ID, &cb)
	default:
		return nil
	}
}

func (s *Service) onMessage(ctx context.Context, updateID int64, m *wire.Message) error {
	user := m.From.ID
	text := strings.TrimSpace(m.Text)
	if name, _, ok := chat.CommandOf(text); ok {
		args := strings.TrimSpace(strings.TrimPrefix(text, strings.Fields(text)[0]))
		switch strings.ToLower(name) {
		case cmdStart:
			s.setPending(user, "")
			return s.send(ctx, updateID, m.Chat.ID, s.copy.welcome, 0, welcomeKeyboard())
		case cmdGuide:
			return s.send(ctx, updateID, m.Chat.ID, s.copy.guide, 0, nil)
		case cmdFeedback:
			if args == "" {
				s.setPending(user, chat.FeedbackIdea)
				return s.send(ctx, updateID, m.Chat.ID, s.copy.askIdea, 0, nil)
			}
			return s.record(ctx, updateID, m, chat.FeedbackIdea, args)
		default:
			return s.send(ctx, updateID, m.Chat.ID, s.copy.unknownCommand, 0, nil)
		}
	}
	if text == "" {
		return s.send(ctx, updateID, m.Chat.ID, s.copy.textOnly, 0, nil)
	}
	return s.record(ctx, updateID, m, s.takePending(user), text)
}

// record files the message as feedback and thanks the user.
func (s *Service) record(ctx context.Context, updateID int64, m *wire.Message, kind, text string) error {
	if _, err := s.chat.RecordFeedback(ctx, m.From.ID, m.Chat.ID, m.Seq, kind, text); err != nil {
		return err
	}
	return s.send(ctx, updateID, m.Chat.ID, s.copy.thanks, m.Seq, nil)
}

func (s *Service) onButton(ctx context.Context, updateID int64, cb *wire.Callback) error {
	if err := s.api.AnswerAsSystemBot(ctx, s.botID, cb.ID, ""); err != nil && !errors.Is(err, botupdates.ErrCallbackNotFound) {
		return err
	}
	chatID := cb.Message.Chat.ID
	switch cb.Data {
	case dataGuide:
		return s.send(ctx, updateID, chatID, s.copy.guide, 0, nil)
	case dataIdea:
		s.setPending(cb.From.ID, chat.FeedbackIdea)
		return s.send(ctx, updateID, chatID, s.copy.askIdea, 0, nil)
	case dataBug:
		s.setPending(cb.From.ID, chat.FeedbackBug)
		return s.send(ctx, updateID, chatID, s.copy.askBug, 0, nil)
	default:
		return nil
	}
}

// send posts text in chatID, once per update (randomID from the update).
func (s *Service) send(ctx context.Context, updateID, chatID int64, text string, replyTo int64, markup *wire.ReplyMarkup) error {
	_, err := s.api.SendAsSystemBot(ctx, s.botID, botapi.OutgoingMessage{
		ChatID: chatID, Text: text, ReplyToSeq: replyTo, ReplyMarkup: markup, RandomID: randomID("update", updateID),
	})
	if connect.CodeOf(err) == connect.CodePermissionDenied {
		// The user blocked the assistant meanwhile: nothing to say.
		s.logger.Info("assistant could not answer", "chat_id", chatID, "err", err)
		return nil
	}
	return err
}

func (s *Service) setPending(user int64, kind string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for id, p := range s.pending {
		if now.After(p.until) {
			delete(s.pending, id)
		}
	}
	if kind == "" {
		delete(s.pending, user)
		return
	}
	s.pending[user] = pendingKind{kind: kind, until: now.Add(pendingTTL)}
}

// takePending returns the kind the user chose for this message (an idea
// unless they pressed "Báo lỗi" lately) and forgets it.
func (s *Service) takePending(user int64) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.pending[user]
	delete(s.pending, user)
	if !ok || time.Now().After(p.until) {
		return chat.FeedbackIdea
	}
	return p.kind
}

// randomID derives a send's random_id (below 2^53, not 0) from what caused
// it, so handling the same cause twice sends once.
func randomID(cause string, id int64) int64 {
	var b [8]byte
	binary.BigEndian.PutUint64(b[:], uint64(id))
	sum := sha256.Sum256(append([]byte("assistant:"+cause+":"), b[:]...))
	return int64(binary.BigEndian.Uint64(sum[:8])&(1<<53-1)) | 1
}

// Reply sends an operator's answer to a feedback item through the
// assistant, as a reply to the user's message, and closes the item. A
// retry after a failure between the send and the record sends nothing new
// (random_id from the item).
func (s *Service) Reply(ctx context.Context, operator, feedbackID int64, text string) (*appv1.Feedback, error) {
	text, err := chat.CleanFeedbackReply(text)
	if err != nil {
		return nil, err
	}
	item, err := s.chat.CheckFeedbackReplyable(ctx, operator, feedbackID)
	if err != nil {
		return nil, err
	}
	out := botapi.OutgoingMessage{
		ChatID: item.ChatID, Text: s.copy.replyPrefix + text, ReplyToSeq: item.Seq, RandomID: randomID("feedback", item.ID),
	}
	if item.FromSettings() {
		// No message of the user's to reply to: a new one quoting it.
		chatID, err := s.chat.SystemBotNoticeChat(ctx, item.UserID)
		if err != nil {
			return nil, err
		}
		if chatID == 0 {
			return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("user_unreachable: the user has no chat with the assistant"))
		}
		out.ChatID, out.ReplyToSeq = chatID, 0
		out.Text = fmt.Sprintf(s.copy.replySettingsPrefix, chat.Excerpt(item.Text, quoteMax)) + text
	}
	if _, err := s.api.SendAsSystemBot(ctx, s.botID, out); err != nil {
		if connect.CodeOf(err) == connect.CodePermissionDenied {
			return nil, connect.NewError(connect.CodeFailedPrecondition,
				fmt.Errorf("user_unreachable: the user blocked the assistant or cannot receive its messages: %w", err))
		}
		return nil, err
	}
	return s.chat.MarkFeedbackReplied(ctx, operator, item.ID, text)
}

// vietnam is the time zone of the dates the assistant writes (no DST).
var vietnam = time.FixedZone("ICT", 7*60*60)

// NotifyModeration tells userID what the moderation team decided, in the
// assistant's chat (chat.Notifier). The chat is opened for them when they
// never pressed Start.
func (s *Service) NotifyModeration(ctx context.Context, userID int64, n chat.ModerationNotice) error {
	text := s.copy.noticeText(n)
	if text == "" {
		return nil
	}
	chatID, err := s.chat.SystemBotNoticeChat(ctx, userID)
	if err != nil || chatID == 0 {
		return err
	}
	_, err = s.api.SendAsSystemBot(ctx, s.botID, botapi.OutgoingMessage{ChatID: chatID, Text: text})
	return err
}

// noticeText is the notice of n; empty when none of its actions concerns
// the user.
func (c copyText) noticeText(n chat.ModerationNotice) string {
	var lines []string
	for _, a := range n.Actions {
		switch a {
		case appv1.ModerationAction_MODERATION_ACTION_WARN:
			lines = append(lines, c.modWarn)
		case appv1.ModerationAction_MODERATION_ACTION_DELETE_MESSAGES:
			lines = append(lines, c.modDeleted)
		case appv1.ModerationAction_MODERATION_ACTION_BAN_FROM_CHAT:
			lines = append(lines, c.modBanned)
		case appv1.ModerationAction_MODERATION_ACTION_RESTRICT_ACCOUNT:
			if n.Until.IsZero() {
				lines = append(lines, c.modLocked)
			} else {
				lines = append(lines, fmt.Sprintf(c.modLockedUntil, n.Until.In(vietnam).Format("15:04 02/01/2006")))
			}
		}
	}
	if len(lines) == 0 {
		return ""
	}
	return c.modHead + "\n\n" + strings.Join(lines, "\n") + "\n\n" + fmt.Sprintf(c.modReason, n.Note)
}
