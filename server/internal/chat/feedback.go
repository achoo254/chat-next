package chat

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	appv1 "app.local/server/gen/app/v1"
	"github.com/jackc/pgx/v5"
)

// Feedback is what users send the team ("Góp ý", "Báo lỗi"): to the
// tenant's assistant bot, which records it here, or from Settings › Góp ý
// (SendFeedback). Operators list it in the moderation queue, mark it
// handled and answer through the assistant; each new item is also posted
// into the operators' group (OpsSignals).
//
// An item sent from Settings has no message in the assistant's chat: it is
// stored with chat_id 0 and seq = -id (unique, so feedback_message_key
// holds), and the answer goes out as a new message quoting it.

// Feedback kinds as stored.
const (
	FeedbackIdea = "idea"
	FeedbackBug  = "bug"
)

// Feedback limits.
const (
	feedbackPageDef = 50
	feedbackPageMax = 200
	// FeedbackReplyMax bounds an operator's answer, in characters.
	FeedbackReplyMax = 2000
	// FeedbackTextMax bounds feedback sent from Settings, in characters.
	FeedbackTextMax = 2000
)

const (
	feedbackOpen    = "open"
	feedbackHandled = "handled"
)

var feedbackKinds = map[string]appv1.FeedbackKind{
	FeedbackIdea: appv1.FeedbackKind_FEEDBACK_KIND_IDEA,
	FeedbackBug:  appv1.FeedbackKind_FEEDBACK_KIND_BUG,
}

// FromSettings reports whether the item was sent from Settings › Góp ý
// (it has no message in the assistant's chat).
func (f *FeedbackItem) FromSettings() bool {
	return f.ChatID == 0
}

// FeedbackItem is one stored feedback message.
type FeedbackItem struct {
	ID, UserID, ChatID, Seq int64
	Kind, Text, Status      string
	CreatedAt               time.Time
	HandledAt               *time.Time
	HandledBy               *int64
	ReplyText               string
	RepliedAt               *time.Time
	RepliedBy               *int64
}

const feedbackColumns = `id, user_id, chat_id, seq, kind, text, status, created_at, handled_at, handled_by,
	reply_text, replied_at, replied_by`

func scanFeedback(row pgx.Row) (*FeedbackItem, error) {
	f := &FeedbackItem{}
	err := row.Scan(&f.ID, &f.UserID, &f.ChatID, &f.Seq, &f.Kind, &f.Text, &f.Status, &f.CreatedAt, &f.HandledAt,
		&f.HandledBy, &f.ReplyText, &f.RepliedAt, &f.RepliedBy)
	return f, err
}

func unixOrZero(t *time.Time) int64 {
	if t == nil {
		return 0
	}
	return t.Unix()
}

func idOrZero(id *int64) int64 {
	if id == nil {
		return 0
	}
	return *id
}

// Render returns the item as operators see it.
func (f *FeedbackItem) Render() *appv1.Feedback {
	status := appv1.FeedbackStatus_FEEDBACK_STATUS_OPEN
	if f.Status == feedbackHandled {
		status = appv1.FeedbackStatus_FEEDBACK_STATUS_HANDLED
	}
	source := appv1.FeedbackSource_FEEDBACK_SOURCE_ASSISTANT
	if f.FromSettings() {
		source = appv1.FeedbackSource_FEEDBACK_SOURCE_SETTINGS
	}
	return &appv1.Feedback{
		Id: f.ID, UserId: f.UserID, Kind: feedbackKinds[f.Kind], Text: f.Text, Status: status,
		CreatedAt: f.CreatedAt.Unix(), HandledAt: unixOrZero(f.HandledAt), HandledBy: idOrZero(f.HandledBy),
		ReplyText: f.ReplyText, RepliedAt: unixOrZero(f.RepliedAt), RepliedBy: idOrZero(f.RepliedBy), Source: source,
	}
}

// RecordFeedback stores the message (chatID, seq) a user sent the assistant
// as feedback of kind. The message is the key: recording it again (an
// update handled twice) changes nothing and reports created false.
func (s *Service) RecordFeedback(ctx context.Context, userID, chatID, seq int64, kind, text string) (created bool, err error) {
	if _, ok := feedbackKinds[kind]; !ok {
		return false, errInvalid("unknown feedback kind %q", kind)
	}
	text = strings.TrimSpace(strings.ToValidUTF8(text, ""))
	if text == "" || userID <= 0 || chatID <= 0 || seq <= 0 {
		return false, errInvalid("feedback needs a user, a message and its text")
	}
	var id int64
	err = s.pool.QueryRow(ctx, `
		INSERT INTO feedback (tenant_id, user_id, kind, text, chat_id, seq) VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (chat_id, seq) DO NOTHING RETURNING id`, s.cfg.TenantID, userID, kind, text, chatID, seq).Scan(&id)
	if isNoRows(err) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("chat: record feedback: %w", err)
	}
	s.signalFeedback(ctx, FeedbackSignal{ID: id, Kind: kind, Text: text, From: Filer{ID: userID}})
	return true, nil
}

// SendFeedback files feedback me typed in Settings › Góp ý (an idea when
// kind is unspecified) and tells the operators' group.
func (s *Service) SendFeedback(ctx context.Context, me int64, req *appv1.SendFeedbackRequest) error {
	kind := FeedbackIdea
	switch req.GetKind() {
	case appv1.FeedbackKind_FEEDBACK_KIND_UNSPECIFIED, appv1.FeedbackKind_FEEDBACK_KIND_IDEA:
	case appv1.FeedbackKind_FEEDBACK_KIND_BUG:
		kind = FeedbackBug
	default:
		return errInvalid("unknown feedback kind")
	}
	text := strings.TrimSpace(strings.ToValidUTF8(req.GetText(), ""))
	if text == "" {
		return errInvalid("text is required")
	}
	if utf8.RuneCountInString(text) > FeedbackTextMax {
		return errInvalid("text is longer than %d characters", FeedbackTextMax)
	}
	if err := s.allow(ctx, limitFeedback, "feedback", me); err != nil {
		return err
	}
	var id int64
	if err := s.pool.QueryRow(ctx, `
		WITH n AS (SELECT nextval(pg_get_serial_sequence('feedback', 'id')) AS id)
		INSERT INTO feedback (id, tenant_id, user_id, kind, text, chat_id, seq)
		SELECT n.id, $1, $2, $3, $4, 0, -n.id FROM n RETURNING id`, s.cfg.TenantID, me, kind, text).Scan(&id); err != nil {
		return fmt.Errorf("chat: send feedback: %w", err)
	}
	s.logger.Info("feedback sent from settings", "feedback_id", id, "user_id", me, "kind", kind)
	s.signalFeedback(ctx, FeedbackSignal{ID: id, Kind: kind, Text: text, FromSettings: true, From: Filer{ID: me}})
	return nil
}

// GetFeedback lists the tenant's feedback of one status, newest first, for
// operators. The cursor is the last id returned.
func (s *Service) GetFeedback(ctx context.Context, me int64, req *appv1.GetFeedbackRequest) (*appv1.GetFeedbackResponse, error) {
	if err := s.requireOperator(me); err != nil {
		return nil, err
	}
	status := feedbackOpen
	switch req.GetStatus() {
	case appv1.FeedbackStatus_FEEDBACK_STATUS_UNSPECIFIED, appv1.FeedbackStatus_FEEDBACK_STATUS_OPEN:
	case appv1.FeedbackStatus_FEEDBACK_STATUS_HANDLED:
		status = feedbackHandled
	default:
		return nil, errInvalid("unknown status")
	}
	before := int64(1<<62 - 1)
	if c := req.GetCursor(); c != "" {
		v, err := strconv.ParseInt(c, 10, 64)
		if err != nil || v <= 0 {
			return nil, errInvalid("invalid cursor")
		}
		before = v
	}
	limit := pageLimit(req.GetLimit(), feedbackPageDef, feedbackPageMax)
	rows, err := s.pool.Query(ctx, `
		SELECT `+feedbackColumns+` FROM feedback WHERE tenant_id = $1 AND status = $2 AND id < $3
		ORDER BY id DESC LIMIT $4`, s.cfg.TenantID, status, before, limit+1)
	if err != nil {
		return nil, fmt.Errorf("chat: list feedback: %w", err)
	}
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (*FeedbackItem, error) { return scanFeedback(r) })
	if err != nil {
		return nil, fmt.Errorf("chat: list feedback: %w", err)
	}
	resp := &appv1.GetFeedbackResponse{}
	if len(list) > limit {
		list = list[:limit]
		resp.NextCursor = strconv.FormatInt(list[len(list)-1].ID, 10)
	}
	ents := newEntitySet()
	for _, f := range list {
		resp.Feedback = append(resp.Feedback, f.Render())
		ents.addUsers(me, f.UserID, idOrZero(f.HandledBy), idOrZero(f.RepliedBy))
	}
	rendered, err := ents.render(ctx, s.pool, s.cfg.TenantID)
	if err != nil {
		return nil, err
	}
	resp.Users = rendered.users[me]
	return resp, nil
}

// Feedback returns one item for an operator.
func (s *Service) Feedback(ctx context.Context, me, id int64) (*FeedbackItem, error) {
	if err := s.requireOperator(me); err != nil {
		return nil, err
	}
	if id <= 0 {
		return nil, errInvalid("feedback_id is required")
	}
	f, err := scanFeedback(s.pool.QueryRow(ctx, `SELECT `+feedbackColumns+` FROM feedback WHERE id = $1 AND tenant_id = $2`,
		id, s.cfg.TenantID))
	if isNoRows(err) {
		return nil, errNotFound("feedback")
	}
	if err != nil {
		return nil, fmt.Errorf("chat: load feedback: %w", err)
	}
	return f, nil
}

// ResolveFeedback marks an item handled by me; an item already handled is
// returned unchanged.
func (s *Service) ResolveFeedback(ctx context.Context, me, id int64) (*appv1.Feedback, error) {
	if _, err := s.Feedback(ctx, me, id); err != nil {
		return nil, err
	}
	if _, err := s.pool.Exec(ctx, `
		UPDATE feedback SET status = $3, handled_at = now(), handled_by = $4
		WHERE id = $1 AND tenant_id = $2 AND status = $5`, id, s.cfg.TenantID, feedbackHandled, me, feedbackOpen); err != nil {
		return nil, fmt.Errorf("chat: resolve feedback: %w", err)
	}
	f, err := s.Feedback(ctx, me, id)
	if err != nil {
		return nil, err
	}
	return f.Render(), nil
}

// CleanFeedbackReply checks an operator's answer.
func CleanFeedbackReply(text string) (string, error) {
	text = strings.TrimSpace(strings.ToValidUTF8(text, ""))
	if text == "" {
		return "", errInvalid("text is required")
	}
	if utf8.RuneCountInString(text) > FeedbackReplyMax {
		return "", errInvalid("text is longer than %d characters", FeedbackReplyMax)
	}
	return text, nil
}

// errAlreadyReplied refuses a second answer to one feedback item.
func errAlreadyReplied() error {
	return errPrecondition("already_replied: this feedback was already answered")
}

// CheckFeedbackReplyable returns the item when me may still answer it.
func (s *Service) CheckFeedbackReplyable(ctx context.Context, me, id int64) (*FeedbackItem, error) {
	f, err := s.Feedback(ctx, me, id)
	if err != nil {
		return nil, err
	}
	if f.RepliedAt != nil {
		return nil, errAlreadyReplied()
	}
	return f, nil
}

// MarkFeedbackReplied records the answer me sent and closes the item.
// Only the first answer is recorded; a later one gives already_replied.
func (s *Service) MarkFeedbackReplied(ctx context.Context, me, id int64, text string) (*appv1.Feedback, error) {
	if err := s.requireOperator(me); err != nil {
		return nil, err
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE feedback SET reply_text = $3, replied_at = now(), replied_by = $4, status = $5,
			handled_at = coalesce(handled_at, now()), handled_by = coalesce(handled_by, $4)
		WHERE id = $1 AND tenant_id = $2 AND replied_at IS NULL`, id, s.cfg.TenantID, text, me, feedbackHandled)
	if err != nil {
		return nil, fmt.Errorf("chat: record feedback answer: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return nil, errAlreadyReplied()
	}
	f, err := s.Feedback(ctx, me, id)
	if err != nil {
		return nil, err
	}
	return f.Render(), nil
}
