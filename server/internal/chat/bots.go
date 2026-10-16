package chat

import (
	"bytes"
	"cmp"
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/entities"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/proto"
)

// Bots are users with is_bot (table bots holds their settings). The core
// enforces the bot rules on every path: the consent invariant (a bot posts
// in a private chat only to a user who started it, followed its deep link,
// pressed its button or wrote to it), membership and send permission in
// groups and channels, no secret chats, no private chats opened by a bot.

// Consent sources (bot_user_consent.source).
const (
	ConsentStart    = "start"
	ConsentDeepLink = "deep_link"
	ConsentButton   = "button"
	ConsentMessage  = "message"
	// ConsentNotice: the assistant opened its chat to tell the user about a
	// moderation decision.
	ConsentNotice = "notice"
)

// Limits of bot messages and buttons.
const (
	callbackDataMax    = 64
	replyRowsMax       = 12
	replyButtonsPerRow = 12
	placeholderMax     = 64
	callbackIDBytes    = 16
)

var startParam = regexp.MustCompile(`^[A-Za-z0-9_-]{0,64}$`)

// errNoConsent is the core's refusal of a bot post to a user who never
// started the bot; the Bot API answers it with 403 no_consent.
func errNoConsent() error {
	return errDenied("no_consent: the user has not started a chat with this bot")
}

// checkPrivatePeer applies the rules of a private chat to a post by me: the
// peer must not have blocked me nor be a deleted bot, a bot needs the
// user's consent, and a user writing to a bot gives that consent (source
// "message"). The saved chat has no peer.
func checkPrivatePeer(ctx context.Context, q querier, c *chatRow, me int64) error {
	if c.Type != typePrivate {
		return nil
	}
	peer := c.peerOf(me)
	if peer == me || peer == 0 {
		return nil
	}
	var blocked, meBot, peerBot, peerGone, peerDeleted, consent bool
	if err := q.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2),
			EXISTS (SELECT 1 FROM users WHERE id = $2 AND is_bot),
			EXISTS (SELECT 1 FROM users WHERE id = $1 AND is_bot),
			EXISTS (SELECT 1 FROM bots WHERE user_id = $1 AND deleted_at IS NOT NULL),
			EXISTS (SELECT 1 FROM users WHERE id = $1 AND (deletion_requested_at IS NOT NULL OR deleted_at IS NOT NULL)),
			EXISTS (SELECT 1 FROM bot_user_consent WHERE (bot_id = $2 AND user_id = $1) OR (bot_id = $1 AND user_id = $2))`,
		peer, me).Scan(&blocked, &meBot, &peerBot, &peerGone, &peerDeleted, &consent); err != nil {
		return fmt.Errorf("chat: check private peer: %w", err)
	}
	switch {
	case peerDeleted:
		return errPrecondition("account_deleted: this account was deleted")
	case blocked:
		return errDenied("this user does not accept your messages")
	case peerGone:
		return errPrecondition("bot_deleted: this bot was deleted")
	case meBot && !consent:
		return errNoConsent()
	case peerBot && !meBot && !consent:
		return recordConsent(ctx, q, peer, me, ConsentMessage)
	default:
		return nil
	}
}

// recordConsent stores that userID allows botID to write to them; the first
// source is kept.
func recordConsent(ctx context.Context, q querier, botID, userID int64, source string) error {
	if _, err := q.Exec(ctx, `
		INSERT INTO bot_user_consent (bot_id, user_id, source) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
		botID, userID, source); err != nil {
		return fmt.Errorf("chat: record bot consent: %w", err)
	}
	return nil
}

// liveBot reports whether id is a bot of the tenant that is not deleted.
func (s *Service) liveBot(ctx context.Context, q querier, id int64) (bool, error) {
	var ok bool
	if err := q.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM bots WHERE user_id = $1 AND tenant_id = $2 AND deleted_at IS NULL)`,
		id, s.cfg.TenantID).Scan(&ok); err != nil {
		return false, fmt.Errorf("chat: find bot: %w", err)
	}
	return ok, nil
}

// ----------------------------------------------------------------- start

// StartBot opens the private chat with the bot and sends "/start [param]"
// as me, recording in the same transaction me's consent for the bot
// (source deep_link with a start parameter, start otherwise). A retry with
// the same random_id does not send again.
func (s *Service) StartBot(ctx context.Context, me int64, req *appv1.StartBotRequest) (*appv1.StartBotResponse, error) {
	botID, param := req.GetBotId(), req.GetStartParam()
	if botID <= 0 || botID == me {
		return nil, errInvalid("bot_id is required")
	}
	if !startParam.MatchString(param) {
		return nil, errInvalid("start_param must have up to 64 characters of A-Z, a-z, 0-9, _ and -")
	}
	if req.GetRandomId() < 0 {
		return nil, errInvalid("random_id must not be negative")
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
	source := ConsentStart
	if param != "" {
		source = ConsentDeepLink
	}
	text := "/start"
	if param != "" {
		text += " " + param
	}
	// The consent is recorded in the transaction of the /start message: a
	// refused send leaves no consent behind.
	sent, err := s.sendMessage(ctx, me, &appv1.SendMessageRequest{
		ChatId: chat.GetId(), Text: text, RandomId: req.GetRandomId(), NoLinkPreview: true,
		Entities: []*appv1.MessageEntity{{Type: appv1.EntityType_ENTITY_TYPE_BOT_COMMAND, Length: int32(len("/start"))}},
	}, source)
	if err != nil {
		return nil, err
	}
	chat, users, err := s.GetChat(ctx, me, chat.GetId())
	if err != nil {
		return nil, err
	}
	return &appv1.StartBotResponse{Chat: chat, Message: sent.GetMessage(), Users: users, Ack: sent.GetAck()}, nil
}

// ------------------------------------------------------------------ send

// BotMessage is a text message a bot posts through the Bot API; Text and
// Entities follow ADR 0004 like every message.
type BotMessage struct {
	ChatID        int64
	TopicID       int64
	Text          string
	Entities      []*appv1.MessageEntity
	ReplyTo       int64
	Markup        *appv1.ReplyMarkup
	RandomID      int64
	NoLinkPreview bool
}

// SendBotMessage posts m as the bot. The chat rules are those of any
// sender (membership, send permission, blocks) plus the consent invariant
// in private chats; the Bot API applies the bot's rate limit tier, so the
// per-user send bucket does not apply here.
func (s *Service) SendBotMessage(ctx context.Context, botID int64, m BotMessage) (*appv1.SendMessageResponse, error) {
	text, ents, err := s.CheckBotMessage(ctx, botID, m)
	if err != nil {
		return nil, err
	}
	ok, err := s.liveBot(ctx, s.pool, botID)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, errDenied("the bot is deleted")
	}
	return s.postText(ctx, botID, textPost{
		chatID: m.ChatID, topicID: m.TopicID, randomID: m.RandomID, replyTo: m.ReplyTo,
		text: text, ents: ents, noPreview: m.NoLinkPreview, markup: m.Markup,
	})
}

// CheckBotMessage checks the content of m as SendBotMessage does, without
// sending (a bulk send checks its message once, before it is queued), and
// returns the normalized text and entities.
func (s *Service) CheckBotMessage(ctx context.Context, botID int64, m BotMessage) (string, []*appv1.MessageEntity, error) {
	text, ents, err := s.validateText(m.Text, m.Entities, false)
	if err != nil {
		return "", nil, err
	}
	if err := s.checkMentions(ctx, botID, ents); err != nil {
		return "", nil, err
	}
	if m.RandomID < 0 {
		return "", nil, errInvalid("random_id must not be negative")
	}
	if err := s.validateBotMarkup(m.Markup); err != nil {
		return "", nil, err
	}
	return text, ents, nil
}

// BotPrivateChat returns the private chat of the bot with user, 0 when
// there is none.
func (s *Service) BotPrivateChat(ctx context.Context, botID, user int64) (int64, error) {
	var chatID int64
	err := s.pool.QueryRow(ctx, `SELECT chat_id FROM private_chats WHERE tenant_id = $1 AND user_low = $2 AND user_high = $3`,
		s.cfg.TenantID, min(botID, user), max(botID, user)).Scan(&chatID)
	if isNoRows(err) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("chat: bot private chat: %w", err)
	}
	return chatID, nil
}

// validateBotMarkup checks a bot keyboard: inline keyboards of callback and
// URL buttons (ADR 0004 schemes), reply keyboards, or a removal.
func (s *Service) validateBotMarkup(m *appv1.ReplyMarkup) error {
	if m == nil {
		return nil
	}
	switch k := m.GetKind().(type) {
	case *appv1.ReplyMarkup_InlineKeyboard:
		rows := k.InlineKeyboard.GetRows()
		if len(rows) == 0 || len(rows) > inlineRowsMax {
			return errInvalid("an inline keyboard has 1 to %d rows", inlineRowsMax)
		}
		for _, row := range rows {
			if len(row.GetButtons()) == 0 || len(row.GetButtons()) > inlineButtonsPerRow {
				return errInvalid("a button row holds 1 to %d buttons", inlineButtonsPerRow)
			}
			for _, b := range row.GetButtons() {
				if err := checkButtonText(b.GetText()); err != nil {
					return err
				}
				switch a := b.GetAction().(type) {
				case *appv1.InlineButton_CallbackData:
					if len(a.CallbackData) == 0 || len(a.CallbackData) > callbackDataMax {
						return errInvalid("callback_data must have 1 to %d bytes", callbackDataMax)
					}
				case *appv1.InlineButton_Url:
					if len(a.Url) > inlineButtonURLBytes || !entities.IsAllowedURL(a.Url, s.cfg.AppScheme) {
						return errInvalid("url_not_allowed: a button links to a URL that is not allowed")
					}
				default:
					return errInvalid("an inline button needs callback_data or url")
				}
			}
		}
	case *appv1.ReplyMarkup_Keyboard:
		kb := k.Keyboard
		if len(kb.GetRows()) == 0 || len(kb.GetRows()) > replyRowsMax {
			return errInvalid("a keyboard has 1 to %d rows", replyRowsMax)
		}
		for _, row := range kb.GetRows() {
			if len(row.GetButtons()) == 0 || len(row.GetButtons()) > replyButtonsPerRow {
				return errInvalid("a keyboard row holds 1 to %d buttons", replyButtonsPerRow)
			}
			for _, b := range row.GetButtons() {
				if err := checkButtonText(b.GetText()); err != nil {
					return err
				}
			}
		}
		if !utf8.ValidString(kb.GetPlaceholder()) || utf8.RuneCountInString(kb.GetPlaceholder()) > placeholderMax {
			return errInvalid("placeholder must have at most %d characters", placeholderMax)
		}
	case *appv1.ReplyMarkup_Remove:
	default:
		return errInvalid("reply_markup needs a keyboard, an inline keyboard or a removal")
	}
	return nil
}

func checkButtonText(text string) error {
	if !utf8.ValidString(text) || strings.TrimSpace(text) == "" || utf8.RuneCountInString(text) > inlineButtonTextMax {
		return errInvalid("button text must have 1 to %d characters", inlineButtonTextMax)
	}
	return nil
}

// --------------------------------------------------------- inline buttons

// ButtonPress is a callback button press handed to the bot.
type ButtonPress struct {
	CallbackID string
	BotID      int64
}

// PressInlineButton records a press of the callback button with data on
// message (chat_id, seq) and writes the inline_button outbox row the bot
// consumer turns into a callback update. The message must be visible to me,
// come from a live bot still in the chat and carry exactly that button. In
// a private chat the press is consent for the bot to write to me.
func (s *Service) PressInlineButton(ctx context.Context, me int64, req *appv1.PressInlineButtonRequest) (*ButtonPress, error) {
	chatID, seq, data := req.GetChatId(), req.GetSeq(), req.GetCallbackData()
	if seq <= 0 {
		return nil, errInvalid("seq is required")
	}
	if len(data) == 0 || len(data) > callbackDataMax {
		return nil, errInvalid("callback_data must have 1 to %d bytes", callbackDataMax)
	}
	if err := s.allow(ctx, limitWrite, "write", me); err != nil {
		return nil, err
	}
	id, err := newCallbackID()
	if err != nil {
		return nil, err
	}
	var press *ButtonPress
	_, err = s.inTx(ctx, func(t *txn) error {
		press = nil
		c, mem, err := s.activeChatFor(ctx, t.tx, chatID, me, false)
		if err != nil {
			return err
		}
		msg, err := s.liveMessage(ctx, t.tx, chatID, seq)
		if err != nil {
			return err
		}
		if !mem.sees(msg) {
			return errNotFound("message")
		}
		var botInChat bool
		if err := t.tx.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM bots b JOIN chat_members m ON m.user_id = b.user_id
				WHERE b.user_id = $1 AND b.tenant_id = $3 AND b.deleted_at IS NULL AND m.chat_id = $2 AND m.left_at IS NULL)`,
			msg.FromID, chatID, s.cfg.TenantID).Scan(&botInChat); err != nil {
			return fmt.Errorf("chat: find button bot: %w", err)
		}
		if !botInChat {
			return errPrecondition("bot_unavailable: the bot of this button is gone")
		}
		if !hasCallbackButton(msg.Content, data) {
			return errInvalid("the message has no button with this callback_data")
		}
		if c.Type == typePrivate {
			if err := recordConsent(ctx, t.tx, msg.FromID, me, ConsentButton); err != nil {
				return err
			}
		}
		ev := t.event(kindInlineButton, chatID, me)
		botID := msg.FromID
		t.afterOutbox = append(t.afterOutbox, func(ctx context.Context) error {
			if _, err := t.tx.Exec(ctx, `
				INSERT INTO bot_callbacks (id, bot_id, user_id, chat_id, seq, data, outbox_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
				id, botID, me, chatID, seq, data, ev.OutboxID); err != nil {
				return fmt.Errorf("chat: record button press: %w", err)
			}
			return nil
		})
		press = &ButtonPress{CallbackID: id, BotID: botID}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return press, nil
}

// hasCallbackButton reports whether stored message content has an inline
// callback button with exactly data.
func hasCallbackButton(content, data []byte) bool {
	if len(content) == 0 {
		return false
	}
	var m appv1.Message
	if proto.Unmarshal(content, &m) != nil {
		return false
	}
	for _, row := range m.GetReplyMarkup().GetInlineKeyboard().GetRows() {
		for _, b := range row.GetButtons() {
			if cb, ok := b.GetAction().(*appv1.InlineButton_CallbackData); ok && bytes.Equal(cb.CallbackData, data) {
				return true
			}
		}
	}
	return false
}

func newCallbackID() (string, error) {
	b := make([]byte, callbackIDBytes)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("chat: callback id: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// ----------------------------------------------------- outbox consumers

// primaryTenant is the tenant whose outbox consumers kept the cursor names
// from before several tenants shared the database.
const primaryTenant = "primary"

// CursorName is the outbox_cursors row of consumer base for this tenant.
func (s *Service) CursorName(base string) string {
	if s.cfg.TenantID == primaryTenant {
		return base
	}
	return base + ":" + s.cfg.TenantID
}

// ReadOutbox returns outbox rows with id above afterID, in id order, at
// most limit.
func (s *Service) ReadOutbox(ctx context.Context, afterID int64, limit int) ([]OutboxRow, error) {
	return s.readOutbox(ctx, `id > $1 ORDER BY id LIMIT `+fmt.Sprint(limit), afterID)
}

// ReadOutboxIDs returns the outbox rows among ids that exist (committed).
func (s *Service) ReadOutboxIDs(ctx context.Context, ids []int64) ([]OutboxRow, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	return s.readOutbox(ctx, `id = ANY($1)`, ids)
}

// Bot update kinds.
const (
	BotUpdateMessage       = "message"
	BotUpdateMessageEdited = "message_edited"
	BotUpdateCallback      = "callback"
	// BotUpdateChannelPost is a new post of a channel the bot administers;
	// an edited post is a BotUpdateMessageEdited of the channel.
	BotUpdateChannelPost = "channel_post"
	// BotUpdateMemberChanged is a change of the bot's own membership: added
	// (also when the chat is created with it), removed or left, promoted,
	// demoted or restricted.
	BotUpdateMemberChanged = "member_changed"
	// BotUpdateReaction is a user's reaction set, changed or removed on a
	// message of the bot.
	BotUpdateReaction = "reaction"
)

// BotRemoval tells that a bot is no longer a member of a chat as of an
// outbox row (kicked or left): its updates of that chat cut before the row
// are not delivered any more.
type BotRemoval struct {
	BotID    int64
	ChatID   int64
	OutboxID int64
}

// BotUpdate is one update for one bot cut from an outbox row, rendered as
// the bot sees it.
type BotUpdate struct {
	BotID    int64
	OutboxID int64
	Kind     string
	// At is when the outbox row was written.
	At      time.Time
	Chat    *appv1.Chat
	Message *appv1.Message
	// Users index the users the update refers to (the message's author and
	// referenced users, the presser of a callback, the peer of a private
	// chat); it may hold more users, shared by the updates of one batch.
	Users    []*appv1.User
	Callback *BotCallback
	// Member: member_changed only (Message is nil).
	Member *BotMemberChange
	// Reaction: reaction only (Message is nil).
	Reaction *BotReaction
	// Inline: inline_query only (Chat and Message are nil).
	Inline *BotInlineQuery
}

// Seq is the message the update is about (0 for member_changed).
func (u BotUpdate) Seq() int64 {
	if u.Reaction != nil {
		return u.Reaction.Seq
	}
	return u.Message.GetSeq()
}

// BotMemberChange is the bot's own membership after a change.
type BotMemberChange struct {
	// ActorID made the change (0: moderation).
	ActorID int64
	// Status is one of the MemberStatus values; Permissions the effective
	// ChatPermission bits.
	Status      string
	Permissions uint32
}

// BotReaction is a user's reaction on a message of the bot as of the
// update; Emoji "" means it was removed.
type BotReaction struct {
	Seq    int64
	UserID int64
	Emoji  string
}

// BotCallback is a button press for the bot.
type BotCallback struct {
	ID     string
	FromID int64
	Data   []byte
}

// botMember is a live bot that is a current member of a chat.
type botMember struct {
	botID       int64
	username    string
	privacy     bool
	visibleFrom int64
}

// botRef is one message a log entry of an outbox row points a bot at.
type botRef struct {
	row  OutboxRow
	bot  int64
	kind string
	seq  int64
}

// BotUpdates cuts the updates for bots out of outbox rows: new and edited
// messages of private chats and groups the bots are in (privacy mode
// applied; never the bot's own messages nor those of other bots), posts of
// channels the bots administer, and presses of their buttons. Rows that
// concern no bot cost one query in total.
func (s *Service) BotUpdates(ctx context.Context, rows []OutboxRow) ([]BotUpdate, error) {
	var chatIDs, pressRows, inlineRows []int64
	var eventRows []OutboxRow
	for _, r := range rows {
		switch r.Kind {
		case kindMessageNew, kindMessageEdit:
			if r.ChatID != 0 {
				chatIDs = append(chatIDs, r.ChatID)
			}
		case kindMemberAdded, kindMemberPermissions, kindReaction:
			if r.ChatID != 0 {
				chatIDs = append(chatIDs, r.ChatID)
				eventRows = append(eventRows, r)
			}
		case kindMemberRemoved:
			if r.ChatID != 0 {
				eventRows = append(eventRows, r)
			}
		case kindInlineButton:
			pressRows = append(pressRows, r.ID)
		case kindInlineQuery:
			inlineRows = append(inlineRows, r.ID)
		default:
		}
	}
	members, err := s.botMembers(ctx, uniqueSorted(chatIDs))
	if err != nil {
		return nil, err
	}
	var out []BotUpdate
	var created []memberEvent
	if len(members) > 0 {
		refs, err := s.botRefs(ctx, rows, members)
		if err != nil {
			return nil, err
		}
		msgs, joined, err := s.botMessageUpdates(ctx, refs, members)
		if err != nil {
			return nil, err
		}
		out = append(out, msgs...)
		created = joined
	}
	if len(eventRows) > 0 || len(created) > 0 {
		events, err := s.botEventUpdates(ctx, eventRows, members, created)
		if err != nil {
			return nil, err
		}
		out = append(out, events...)
	}
	if len(pressRows) > 0 {
		presses, err := s.botCallbackUpdates(ctx, rows, pressRows)
		if err != nil {
			return nil, err
		}
		out = append(out, presses...)
	}
	if len(inlineRows) > 0 {
		asks, err := s.botInlineUpdates(ctx, rows, inlineRows)
		if err != nil {
			return nil, err
		}
		out = append(out, asks...)
	}
	slices.SortStableFunc(out, func(a, b BotUpdate) int {
		return cmp.Or(cmp.Compare(a.OutboxID, b.OutboxID), cmp.Compare(a.Seq(), b.Seq()))
	})
	return out, nil
}

// botMembers returns the live bots that are current members of chats:
// private chats and groups, and channels where the bot is an admin (a
// channel's subscribers do not see posts as updates).
func (s *Service) botMembers(ctx context.Context, chatIDs []int64) (map[int64][]botMember, error) {
	out := map[int64][]botMember{}
	if len(chatIDs) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT m.chat_id, b.user_id, u.username, b.privacy, m.visible_from_seq
		FROM chat_members m JOIN bots b ON b.user_id = m.user_id JOIN users u ON u.id = b.user_id
		JOIN chats c ON c.id = m.chat_id
		WHERE m.chat_id = ANY($1) AND m.left_at IS NULL AND b.deleted_at IS NULL AND b.tenant_id = $2
			AND c.deleted_at IS NULL
			AND (c.type IN ('private', 'group') OR (c.type = 'channel' AND m.role IN ('admin', 'owner')))`, chatIDs, s.cfg.TenantID)
	if err != nil {
		return nil, fmt.Errorf("chat: bot members: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var chatID int64
		var b botMember
		if err := rows.Scan(&chatID, &b.botID, &b.username, &b.privacy, &b.visibleFrom); err != nil {
			return nil, fmt.Errorf("chat: bot members: %w", err)
		}
		out[chatID] = append(out[chatID], b)
	}
	return out, rows.Err()
}

// botRefs reads, from the log entries the outbox rows point at, which
// messages each bot member got: its own log entries in small chats, the
// chat log in large ones.
func (s *Service) botRefs(ctx context.Context, rows []OutboxRow, members map[int64][]botMember) ([]botRef, error) {
	type logKey struct{ id, pos int64 }
	var users, pts, chats, chatPts []int64
	userRow := map[logKey]OutboxRow{}
	chatRow := map[logKey]OutboxRow{}
	for _, r := range rows {
		bots := members[r.ChatID]
		if (r.Kind != kindMessageNew && r.Kind != kindMessageEdit) || len(bots) == 0 {
			continue
		}
		for i, u := range r.UserIDs {
			if i < len(r.Pts) && slices.ContainsFunc(bots, func(b botMember) bool { return b.botID == u }) {
				users, pts = append(users, u), append(pts, r.Pts[i])
				userRow[logKey{u, r.Pts[i]}] = r
			}
		}
		for _, p := range r.ChatPts {
			chats, chatPts = append(chats, r.ChatID), append(chatPts, p)
			chatRow[logKey{r.ChatID, p}] = r
		}
	}
	var refs []botRef
	add := func(r OutboxRow, bot int64, u *appv1.Update) {
		switch k := u.GetKind().(type) {
		case *appv1.Update_MessageNew:
			refs = append(refs, botRef{row: r, bot: bot, kind: BotUpdateMessage, seq: k.MessageNew.GetMessage().GetSeq()})
		case *appv1.Update_MessageEdit:
			refs = append(refs, botRef{row: r, bot: bot, kind: BotUpdateMessageEdited, seq: k.MessageEdit.GetMessage().GetSeq()})
		default:
		}
	}
	if err := readUserLog(ctx, s.pool, users, pts, func(user, pos int64, u *appv1.Update) {
		add(userRow[logKey{user, pos}], user, u)
	}); err != nil {
		return nil, err
	}
	if err := readChatLog(ctx, s.pool, chats, chatPts, func(chatID, pos int64, u *appv1.Update) {
		r := chatRow[logKey{chatID, pos}]
		for _, b := range members[r.ChatID] {
			add(r, b.botID, u)
		}
	}); err != nil {
		return nil, err
	}
	return refs, nil
}

// botMessageUpdates loads and filters the referenced messages, then renders
// them per bot: one render of all its messages and one chat render per
// chat it is in, whatever the number of updates. It also returns, as
// member events, the bots a chat was created with (their chat_created
// service message).
func (s *Service) botMessageUpdates(ctx context.Context, refs []botRef, members map[int64][]botMember) ([]BotUpdate, []memberEvent, error) {
	if len(refs) == 0 {
		return nil, nil, nil
	}
	keys := map[int64][]int64{}
	for _, r := range refs {
		keys[r.row.ChatID] = append(keys[r.row.ChatID], r.seq)
	}
	msgs, err := loadMessages(ctx, s.pool, keys)
	if err != nil {
		return nil, nil, err
	}
	chats, err := loadChats(ctx, s.pool, s.cfg.TenantID, sortedKeysOf(keys))
	if err != nil {
		return nil, nil, err
	}
	// Authors that are bots, and authors of replied-to messages (privacy).
	replies := map[int64][]int64{}
	var authors []int64
	for _, m := range msgs {
		authors = append(authors, m.FromID)
		if m.ReplyToSeq != 0 {
			replies[m.ChatID] = append(replies[m.ChatID], m.ReplyToSeq)
		}
	}
	botAuthors, err := botsAmong(ctx, s.pool, uniqueSorted(authors))
	if err != nil {
		return nil, nil, err
	}
	replied, err := loadMessages(ctx, s.pool, replies)
	if err != nil {
		return nil, nil, err
	}
	batches := newBotBatches()
	var created []memberEvent
	for _, ref := range refs {
		m := msgs[msgKey{ref.row.ChatID, ref.seq}]
		c := chats[ref.row.ChatID]
		if m == nil || m.Deleted || c == nil || m.FromID == ref.bot || botAuthors[m.FromID] {
			continue
		}
		var member *botMember
		for i := range members[ref.row.ChatID] {
			if members[ref.row.ChatID][i].botID == ref.bot {
				member = &members[ref.row.ChatID][i]
			}
		}
		if member == nil || m.Seq < member.visibleFrom {
			continue
		}
		if ref.kind == BotUpdateMessageEdited && !editedBy(m, ref.row) {
			continue
		}
		if c.Type == typeGroup && member.privacy && !s.reachesPrivateBot(m, member, replied) {
			continue
		}
		kind := ref.kind
		if c.Type == typeChannel && kind == BotUpdateMessage {
			kind = BotUpdateChannelPost
		}
		if kind == BotUpdateMessage && isChatCreated(m) {
			created = append(created, memberEvent{row: ref.row, bot: ref.bot, chatID: c.ID,
				change: BotMemberChange{ActorID: m.FromID, Status: MemberStatusMember}})
		}
		batches.add(ref.bot, c, m, BotUpdate{BotID: ref.bot, OutboxID: ref.row.ID, Kind: kind, At: ref.row.CreatedAt})
	}
	out, err := s.renderBotBatches(ctx, batches)
	if err != nil {
		return nil, nil, err
	}
	return out, created, nil
}

// editedBy reports whether the message_edit outbox row is the edit that
// set the message's current edit_date. An edit sets edit_date to the time
// of its transaction, which is also the row's created_at. A server-side
// rewrite (a link preview or processed media attached later) keeps the
// older edit_date and is not an edit for the bot; neither is an earlier
// edit superseded meanwhile, as the later edit's own row delivers the
// current text.
func editedBy(m *messageRow, row OutboxRow) bool {
	return m.EditDate != nil && m.EditDate.Equal(row.CreatedAt)
}

// botBatches groups the updates of a consumer pass by bot, with the
// messages and chats each bot sees, so each bot's messages render at once.
type botBatches struct {
	order []int64
	byBot map[int64]*botBatch
}

type botBatch struct {
	updates []BotUpdate
	// keys: the message of each update.
	keys  []msgKey
	msgs  map[msgKey]*messageRow
	chats map[int64]*chatRow
	// users of the callback pressers.
	users []int64
}

func newBotBatches() *botBatches {
	return &botBatches{byBot: map[int64]*botBatch{}}
}

func (b *botBatches) add(bot int64, c *chatRow, m *messageRow, u BotUpdate) *botBatch {
	batch := b.byBot[bot]
	if batch == nil {
		batch = &botBatch{msgs: map[msgKey]*messageRow{}, chats: map[int64]*chatRow{}}
		b.byBot[bot] = batch
		b.order = append(b.order, bot)
	}
	k := msgKey{m.ChatID, m.Seq}
	batch.updates, batch.keys = append(batch.updates, u), append(batch.keys, k)
	batch.msgs[k], batch.chats[c.ID] = m, c
	return batch
}

// renderBotBatches renders each bot's messages and chats as the bot sees
// them and fills in its updates.
func (s *Service) renderBotBatches(ctx context.Context, b *botBatches) ([]BotUpdate, error) {
	var out []BotUpdate
	for _, bot := range b.order {
		batch := b.byBot[bot]
		rows := make([]*messageRow, 0, len(batch.msgs))
		for _, m := range batch.msgs {
			rows = append(rows, m)
		}
		rendered, users, err := s.renderMessages(ctx, s.pool, bot, rows)
		if err != nil {
			return nil, err
		}
		byKey := make(map[msgKey]*appv1.Message, len(rendered))
		for _, m := range rendered {
			byKey[msgKey{m.GetChatId(), m.GetSeq()}] = m
		}
		chatOf := make(map[int64]*appv1.Chat, len(batch.chats))
		for id, c := range batch.chats {
			chat, peers, err := s.botChat(ctx, c, bot)
			if err != nil {
				return nil, err
			}
			chatOf[id] = chat
			users = mergeUsers(users, peers)
		}
		if len(batch.users) > 0 {
			list, err := loadUsers(ctx, s.pool, s.cfg.TenantID, uniqueSorted(batch.users))
			if err != nil {
				return nil, err
			}
			more := make([]*appv1.User, 0, len(list))
			for _, u := range list {
				more = append(more, u.render(bot, false))
			}
			users = mergeUsers(users, more)
		}
		for i, u := range batch.updates {
			k := batch.keys[i]
			u.Chat, u.Message, u.Users = chatOf[k.chatID], byKey[k], users
			if u.Message == nil {
				return nil, fmt.Errorf("chat: bot update: message %d/%d not rendered", k.chatID, k.seq)
			}
			out = append(out, u)
		}
	}
	return out, nil
}

// reachesPrivateBot is the privacy mode filter of groups: service
// messages, replies to the bot's messages and commands addressed to it
// ("/cmd" or "/cmd@botname" at the start of the text).
func (s *Service) reachesPrivateBot(m *messageRow, b *botMember, replied map[msgKey]*messageRow) bool {
	if len(m.Content) > 0 {
		var content appv1.Message
		if proto.Unmarshal(m.Content, &content) == nil && content.GetAction() != nil {
			return true
		}
	}
	if r := replied[msgKey{m.ChatID, m.ReplyToSeq}]; m.ReplyToSeq != 0 && r != nil && r.FromID == b.botID {
		return true
	}
	_, target, ok := CommandOf(m.Text)
	return ok && (target == "" || strings.EqualFold(target, b.username))
}

var commandPattern = regexp.MustCompile(`^/([A-Za-z0-9_]{1,64})(?:@([A-Za-z0-9_]{1,32}))?(?:\s|$)`)

// CommandOf parses a bot command at the start of text: "/name" or
// "/name@bot" followed by whitespace or the end.
func CommandOf(text string) (name, target string, ok bool) {
	m := commandPattern.FindStringSubmatch(text)
	if m == nil {
		return "", "", false
	}
	return m[1], m[2], true
}

// botChat renders a chat for a bot member, with the private peer.
func (s *Service) botChat(ctx context.Context, c *chatRow, botID int64) (*appv1.Chat, []*appv1.User, error) {
	m, err := s.memberRow(ctx, s.pool, c.ID, botID)
	if err != nil && !isNotFound(err) {
		return nil, nil, err
	}
	chat := c.render(botID, m)
	var users []*appv1.User
	if peer := chat.GetPeerUserId(); peer != 0 {
		list, err := loadUsers(ctx, s.pool, s.cfg.TenantID, []int64{peer})
		if err != nil {
			return nil, nil, err
		}
		if u := list[peer]; u != nil {
			users = append(users, u.render(botID, false))
		}
	}
	return chat, users, nil
}

// botCallbackUpdates turns inline_button rows into callback updates. A
// press of a message deleted meanwhile is dropped.
func (s *Service) botCallbackUpdates(ctx context.Context, rows []OutboxRow, ids []int64) ([]BotUpdate, error) {
	at := map[int64]time.Time{}
	for _, r := range rows {
		at[r.ID] = r.CreatedAt
	}
	list, err := s.pool.Query(ctx, `
		SELECT c.id, c.bot_id, c.user_id, c.chat_id, c.seq, c.data, c.outbox_id FROM bot_callbacks c
		JOIN bots b ON b.user_id = c.bot_id
		WHERE c.outbox_id = ANY($1) AND b.deleted_at IS NULL AND b.tenant_id = $2 ORDER BY c.outbox_id`, ids, s.cfg.TenantID)
	if err != nil {
		return nil, fmt.Errorf("chat: button presses: %w", err)
	}
	type press struct {
		cb                   BotCallback
		bot, chat, seq, outb int64
	}
	presses, err := pgx.CollectRows(list, func(r pgx.CollectableRow) (press, error) {
		var p press
		err := r.Scan(&p.cb.ID, &p.bot, &p.cb.FromID, &p.chat, &p.seq, &p.cb.Data, &p.outb)
		return p, err
	})
	if err != nil {
		return nil, fmt.Errorf("chat: button presses: %w", err)
	}
	if len(presses) == 0 {
		return nil, nil
	}
	keys := map[int64][]int64{}
	for _, p := range presses {
		keys[p.chat] = append(keys[p.chat], p.seq)
	}
	msgs, err := loadMessages(ctx, s.pool, keys)
	if err != nil {
		return nil, err
	}
	chats, err := loadChats(ctx, s.pool, s.cfg.TenantID, sortedKeysOf(keys))
	if err != nil {
		return nil, err
	}
	batches := newBotBatches()
	for _, p := range presses {
		m, c := msgs[msgKey{p.chat, p.seq}], chats[p.chat]
		if m == nil || m.Deleted || c == nil {
			continue
		}
		cb := p.cb
		batch := batches.add(p.bot, c, m, BotUpdate{
			BotID: p.bot, OutboxID: p.outb, Kind: BotUpdateCallback, At: at[p.outb], Callback: &cb,
		})
		batch.users = append(batch.users, p.cb.FromID)
	}
	return s.renderBotBatches(ctx, batches)
}

// BotRemovals reads, for the member_removed rows among rows, which bots
// are not members of those chats any more. A bot that was added back since
// is a member again and keeps its updates.
func (s *Service) BotRemovals(ctx context.Context, rows []OutboxRow) ([]BotRemoval, error) {
	last := map[int64]int64{}
	for _, r := range rows {
		if r.Kind == kindMemberRemoved && r.ChatID != 0 {
			last[r.ChatID] = max(last[r.ChatID], r.ID)
		}
	}
	if len(last) == 0 {
		return nil, nil
	}
	chats := make([]int64, 0, len(last))
	for id := range last {
		chats = append(chats, id)
	}
	slices.Sort(chats)
	list, err := s.pool.Query(ctx, `
		SELECT m.chat_id, m.user_id FROM chat_members m JOIN bots b ON b.user_id = m.user_id
		WHERE m.chat_id = ANY($1) AND m.left_at IS NOT NULL AND b.tenant_id = $2 ORDER BY m.chat_id, m.user_id`,
		chats, s.cfg.TenantID)
	if err != nil {
		return nil, fmt.Errorf("chat: removed bots: %w", err)
	}
	out, err := pgx.CollectRows(list, func(r pgx.CollectableRow) (BotRemoval, error) {
		var b BotRemoval
		err := r.Scan(&b.ChatID, &b.BotID)
		b.OutboxID = last[b.ChatID]
		return b, err
	})
	if err != nil {
		return nil, fmt.Errorf("chat: removed bots: %w", err)
	}
	return out, nil
}

// botsAmong returns which of ids are bots.
func botsAmong(ctx context.Context, q querier, ids []int64) (map[int64]bool, error) {
	out := map[int64]bool{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := q.Query(ctx, `SELECT id FROM users WHERE id = ANY($1) AND is_bot`, ids)
	if err != nil {
		return nil, fmt.Errorf("chat: find bots: %w", err)
	}
	list, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return nil, fmt.Errorf("chat: find bots: %w", err)
	}
	for _, id := range list {
		out[id] = true
	}
	return out, nil
}

func sortedKeysOf(m map[int64][]int64) []int64 {
	out := make([]int64, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}

// readUserLog calls fn with the user log entries (users[i], pts[i]) that
// exist, in user and pts order.
func readUserLog(ctx context.Context, q querier, users, pts []int64, fn func(user, pts int64, u *appv1.Update)) error {
	if len(users) == 0 {
		return nil
	}
	rows, err := q.Query(ctx, `
		SELECT u.user_id, u.pts, u."update" FROM user_updates u
		JOIN unnest($1::bigint[], $2::bigint[]) AS x(user_id, pts) ON x.user_id = u.user_id AND x.pts = u.pts
		ORDER BY u.user_id, u.pts`, users, pts)
	if err != nil {
		return fmt.Errorf("chat: bot log entries: %w", err)
	}
	return eachLogEntry(rows, fn)
}

// readChatLog calls fn with the chat log entries (chats[i], chatPts[i])
// that exist, in chat and chat_pts order.
func readChatLog(ctx context.Context, q querier, chats, chatPts []int64, fn func(chatID, chatPts int64, u *appv1.Update)) error {
	if len(chats) == 0 {
		return nil
	}
	rows, err := q.Query(ctx, `
		SELECT u.chat_id, u.chat_pts, u."update" FROM chat_updates u
		JOIN unnest($1::bigint[], $2::bigint[]) AS x(chat_id, chat_pts) ON x.chat_id = u.chat_id AND x.chat_pts = u.chat_pts
		ORDER BY u.chat_id, u.chat_pts`, chats, chatPts)
	if err != nil {
		return fmt.Errorf("chat: bot chat log entries: %w", err)
	}
	return eachLogEntry(rows, fn)
}

func eachLogEntry(rows pgx.Rows, fn func(id, pos int64, u *appv1.Update)) error {
	defer rows.Close()
	for rows.Next() {
		var id, pos int64
		var payload []byte
		if err := rows.Scan(&id, &pos, &payload); err != nil {
			return fmt.Errorf("chat: bot log entries: %w", err)
		}
		u, err := decodeStored(payload)
		if err != nil {
			return err
		}
		fn(id, pos, u)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("chat: bot log entries: %w", err)
	}
	return nil
}

// checkPrivateBotSources lets a bot in privacy mode repost from a group
// only the messages it could have received as updates, or wrote: privacy
// mode limits what the bot reads, not only what is pushed to it.
func (s *Service) checkPrivateBotSources(ctx context.Context, c *chatRow, me int64, sources []*messageRow) error {
	if c.Type != typeGroup {
		return nil
	}
	members, err := s.botMembers(ctx, []int64{c.ID})
	if err != nil {
		return err
	}
	var bot *botMember
	for i := range members[c.ID] {
		if members[c.ID][i].botID == me {
			bot = &members[c.ID][i]
		}
	}
	if bot == nil || !bot.privacy {
		return nil
	}
	replies := map[int64][]int64{}
	for _, m := range sources {
		if m.ReplyToSeq != 0 {
			replies[m.ChatID] = append(replies[m.ChatID], m.ReplyToSeq)
		}
	}
	replied, err := loadMessages(ctx, s.pool, replies)
	if err != nil {
		return err
	}
	for _, m := range sources {
		if m.FromID != me && !s.reachesPrivateBot(m, bot, replied) {
			return errNotFound("message")
		}
	}
	return nil
}
