package chat

import (
	"context"
	"fmt"
	"unicode/utf8"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/entities"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/proto"
)

// Limits of integration (incoming webhook) messages.
const (
	integrationLabelMax  = 64
	inlineRowsMax        = 8
	inlineButtonsPerRow  = 8
	inlineButtonTextMax  = 64
	inlineButtonURLBytes = 2048
)

// IntegrationMessage is what an incoming webhook posts: text with entities,
// optional URL buttons, under the hook's label. It is posted with from_id 0.
type IntegrationMessage struct {
	// Label is the hook name, shown as "Integration: <label>".
	Label    string
	Text     string
	Entities []*appv1.MessageEntity
	// Buttons are rows of URL buttons (no callbacks: a hook has no bot).
	Buttons [][]IntegrationButton
	Silent  bool
}

// IntegrationButton opens URL.
type IntegrationButton struct {
	Text string
	URL  string
}

// IntegrationTx is a transaction on a chat's integrations: one webhook
// request into the chat, or an admin managing its hooks. The chat row is
// locked, so every request into the chat (and every membership change,
// which may disable the hook) is serialized with it.
type IntegrationTx struct {
	t         *txn
	c         *chatRow
	delivered func(reached bool)
}

// Tx is the transaction, for the caller's own tables.
func (it *IntegrationTx) Tx() pgx.Tx {
	return it.t.tx
}

// ChatID is the locked chat.
func (it *IntegrationTx) ChatID() int64 {
	return it.c.ID
}

// WithIntegration runs fn in a transaction holding the lock of chatID, a
// live group or channel of the tenant (NotFound otherwise). delivered, when
// set, learns after commit whether each posted or edited message reached a
// recipient online. A serialization failure retries fn.
func (s *Service) WithIntegration(ctx context.Context, chatID int64, delivered func(reached bool), fn func(*IntegrationTx) error) error {
	_, err := s.inTx(ctx, func(t *txn) error {
		c, err := scanChat(t.tx.QueryRow(ctx, `SELECT `+chatColumns+` FROM `+chatFrom+`
			WHERE c.id = $1 AND c.tenant_id = $2 AND c.deleted_at IS NULL FOR UPDATE OF c`, chatID, s.cfg.TenantID))
		if isNoRows(err) {
			return errNotFound("chat")
		}
		if err != nil {
			return fmt.Errorf("chat: load chat: %w", err)
		}
		if c.Type != typeGroup && c.Type != typeChannel {
			return errNotFound("chat")
		}
		return fn(&IntegrationTx{t: t, c: c, delivered: delivered})
	})
	return err
}

// content validates msg and returns the stored text and content.
func (it *IntegrationTx) content(msg IntegrationMessage) (string, *appv1.Message, error) {
	if msg.Label == "" || utf8.RuneCountInString(msg.Label) > integrationLabelMax {
		return "", nil, errInvalid("integration label must have 1 to %d characters", integrationLabelMax)
	}
	text, ents, err := it.t.s.validateText(msg.Text, msg.Entities, false)
	if err != nil {
		return "", nil, err
	}
	markup, err := it.t.s.inlineURLKeyboard(msg.Buttons)
	if err != nil {
		return "", nil, err
	}
	return text, &appv1.Message{Entities: ents, IntegrationLabel: msg.Label, ReplyMarkup: markup, Silent: msg.Silent}, nil
}

// inlineURLKeyboard validates URL button rows (ADR 0004 schemes).
func (s *Service) inlineURLKeyboard(rows [][]IntegrationButton) (*appv1.ReplyMarkup, error) {
	if len(rows) == 0 {
		return nil, nil
	}
	if len(rows) > inlineRowsMax {
		return nil, errInvalid("at most %d button rows", inlineRowsMax)
	}
	kb := &appv1.InlineKeyboard{}
	for _, row := range rows {
		if len(row) == 0 || len(row) > inlineButtonsPerRow {
			return nil, errInvalid("a button row holds 1 to %d buttons", inlineButtonsPerRow)
		}
		out := &appv1.InlineKeyboardRow{}
		for _, b := range row {
			if !utf8.ValidString(b.Text) || b.Text == "" || utf8.RuneCountInString(b.Text) > inlineButtonTextMax {
				return nil, errInvalid("button text must have 1 to %d characters", inlineButtonTextMax)
			}
			if len(b.URL) > inlineButtonURLBytes || !entities.IsAllowedURL(b.URL, s.cfg.AppScheme) {
				return nil, errInvalid("url_not_allowed: a button links to a URL that is not allowed")
			}
			out.Buttons = append(out.Buttons, &appv1.InlineButton{Text: b.Text, Action: &appv1.InlineButton_Url{Url: b.URL}})
		}
		kb.Rows = append(kb.Rows, out)
	}
	return &appv1.ReplyMarkup{Kind: &appv1.ReplyMarkup_InlineKeyboard{InlineKeyboard: kb}}, nil
}

// Post posts msg as a new message of the integration (from_id 0; General
// topic in a forum) and returns its seq.
func (it *IntegrationTx) Post(ctx context.Context, msg IntegrationMessage) (int64, error) {
	text, content, err := it.content(msg)
	if err != nil {
		return 0, err
	}
	members, err := it.t.fanoutMembers(ctx, it.c)
	if err != nil {
		return 0, err
	}
	ev := it.t.event(kindMessageNew, it.c.ID, 0)
	ev.delivered = it.delivered
	posted, err := it.t.postMessage(ctx, ev, it.c, members, newMessage{text: text, content: content})
	if err != nil {
		return 0, err
	}
	return posted.Seq, nil
}

// Edit replaces an integration message in place (marked edited). notify
// asks clients to notify as for a new message. It reports false, changing
// nothing, when the message is gone (deleted, recalled) or not an
// integration message.
func (it *IntegrationTx) Edit(ctx context.Context, seq int64, msg IntegrationMessage, notify bool) (bool, error) {
	text, content, err := it.content(msg)
	if err != nil {
		return false, err
	}
	m, err := it.t.s.liveMessage(ctx, it.t.tx, it.c.ID, seq)
	if isNotFound(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if m.FromID != 0 || len(m.Content) == 0 {
		return false, nil
	}
	var old appv1.Message
	if err := proto.Unmarshal(m.Content, &old); err != nil {
		return false, fmt.Errorf("chat: decode message: %w", err)
	}
	if old.GetIntegrationLabel() == "" {
		return false, nil
	}
	before := len(it.t.events)
	if err := it.t.rewriteMessage(ctx, it.c, 0, m, text, content, true, notify); err != nil {
		return false, err
	}
	for _, ev := range it.t.events[before:] {
		ev.delivered = it.delivered
	}
	return true, nil
}

// HookStopped posts the service message of an incoming webhook that stopped
// posting: actor is the admin who turned it off or deleted it. Channels get
// none (see hookStopped).
func (it *IntegrationTx) HookStopped(ctx context.Context, actor int64, hookName string, reason appv1.IncomingHookStopReason) error {
	return it.t.hookStopped(ctx, it.c, actor, hookName, reason)
}

// hookStopped posts ActionIncomingHookStopped in a group, from actor (0 for
// the server). Channels get no service message, as for membership changes:
// their subscribers do not see how the channel is run.
func (t *txn) hookStopped(ctx context.Context, c *chatRow, actor int64, hookName string, reason appv1.IncomingHookStopReason) error {
	if c.Type != typeGroup {
		return nil
	}
	members, err := t.fanoutMembers(ctx, c)
	if err != nil {
		return err
	}
	action := &appv1.MessageAction{Kind: &appv1.MessageAction_IncomingHookStopped{IncomingHookStopped: &appv1.ActionIncomingHookStopped{
		HookName: hookName, Reason: reason,
	}}}
	ev := t.event(kindMessageNew, c.ID, actor)
	_, err = t.postMessage(ctx, ev, c, members, newMessage{fromID: actor, content: &appv1.Message{Action: action}})
	return err
}

// hookStopReasons maps the disabled_reason the membership trigger writes.
var hookStopReasons = map[string]appv1.IncomingHookStopReason{
	"creator_not_admin": appv1.IncomingHookStopReason_INCOMING_HOOK_STOP_REASON_CREATOR_NOT_ADMIN,
	"creator_left":      appv1.IncomingHookStopReason_INCOMING_HOOK_STOP_REASON_CREATOR_LEFT,
}

// announceHooksOff posts, as the server, the service message of each hook
// created by userID that the membership trigger (migration 0007) turned off
// in this transaction, right after userID was demoted or left. The trigger
// stamps disabled_at with now(), the transaction's start time, which tells
// these hooks apart from ones turned off earlier.
func (t *txn) announceHooksOff(ctx context.Context, c *chatRow, userID int64) error {
	if c.Type != typeGroup {
		return nil
	}
	rows, err := t.tx.Query(ctx, `
		SELECT name, disabled_reason FROM incoming_hooks
		WHERE chat_id = $1 AND created_by = $2 AND state = 'auto_disabled' AND disabled_at = now()
		ORDER BY created_at, id`, c.ID, userID)
	if err != nil {
		return fmt.Errorf("chat: hooks turned off: %w", err)
	}
	type stopped struct{ name, reason string }
	hooks, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (stopped, error) {
		var h stopped
		err := r.Scan(&h.name, &h.reason)
		return h, err
	})
	if err != nil {
		return fmt.Errorf("chat: hooks turned off: %w", err)
	}
	for _, h := range hooks {
		if err := t.hookStopped(ctx, c, 0, h.name, hookStopReasons[h.reason]); err != nil {
			return err
		}
	}
	return nil
}

// ------------------------------------------------------- admin transactions

// WithChatAdmin runs fn in a transaction holding the lock of chatID when me
// is a current admin (or the owner) of the group or channel and not
// restricted: NotFound when the chat is unknown to me, PermissionDenied for
// other members.
func (s *Service) WithChatAdmin(ctx context.Context, chatID, me int64, fn func(it *IntegrationTx) error) error {
	if err := s.allow(ctx, limitWrite, "write", me); err != nil {
		return err
	}
	_, err := s.inTx(ctx, func(t *txn) error {
		c, m, err := s.activeChatFor(ctx, t.tx, chatID, me, true)
		if err != nil {
			return err
		}
		if (c.Type != typeGroup && c.Type != typeChannel) || !m.isAdmin() {
			return errDenied("only admins manage the integrations of this chat")
		}
		if err := s.checkUnrestricted(ctx, t.tx, me); err != nil {
			return err
		}
		return fn(&IntegrationTx{t: t, c: c})
	})
	return err
}

// CheckChatAdmin is the read-only check of WithChatAdmin.
func (s *Service) CheckChatAdmin(ctx context.Context, chatID, me int64) error {
	c, m, err := s.activeChatFor(ctx, s.pool, chatID, me, false)
	if err != nil {
		return err
	}
	if (c.Type != typeGroup && c.Type != typeChannel) || !m.isAdmin() {
		return errDenied("only admins manage the integrations of this chat")
	}
	return nil
}

// IsChatAdmin reports whether userID is a current admin (or the owner) of
// chatID, inside the caller's transaction.
func IsChatAdmin(ctx context.Context, tx pgx.Tx, chatID, userID int64) (bool, error) {
	var admin bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2 AND left_at IS NULL AND role IN ('admin', 'owner'))`,
		chatID, userID).Scan(&admin); err != nil {
		return false, fmt.Errorf("chat: check admin: %w", err)
	}
	return admin, nil
}
