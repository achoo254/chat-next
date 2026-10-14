package chat

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	appv1 "app.local/server/gen/app/v1"
	"github.com/jackc/pgx/v5"
)

// The moderation queue: operators (Config.Operators) list, inspect and
// close the tenant's reports; actions are recorded in moderation_log.
const (
	reportsPageDef     = 50
	reportsPageMax     = 200
	moderationNoteMax  = 1000
	restrictMaxSeconds = 366 * 24 * 60 * 60
	// contextAround is how many messages around the reported ones an
	// operator sees.
	contextAround = 5
	historyMax    = 20
	// reasonAdmin is app.v1.SessionRevokeReason ADMIN.
	reasonAdmin = int16(appv1.SessionRevokeReason_SESSION_REVOKE_REASON_ADMIN)
)

// Report statuses and moderation actions as stored.
const (
	statusOpen      = "open"
	statusResolved  = "resolved"
	statusDismissed = "dismissed"
)

var actionNames = map[appv1.ModerationAction]string{
	appv1.ModerationAction_MODERATION_ACTION_DISMISS:          "dismiss",
	appv1.ModerationAction_MODERATION_ACTION_DELETE_MESSAGES:  "delete_messages",
	appv1.ModerationAction_MODERATION_ACTION_BAN_FROM_CHAT:    "ban_from_chat",
	appv1.ModerationAction_MODERATION_ACTION_RESTRICT_ACCOUNT: "restrict_account",
	appv1.ModerationAction_MODERATION_ACTION_LIFT_RESTRICTION: "lift_restriction",
}

func actionOf(name string) appv1.ModerationAction {
	for a, n := range actionNames {
		if n == name {
			return a
		}
	}
	return appv1.ModerationAction_MODERATION_ACTION_UNSPECIFIED
}

var reportStatuses = map[string]appv1.ReportStatus{
	statusOpen:      appv1.ReportStatus_REPORT_STATUS_OPEN,
	statusResolved:  appv1.ReportStatus_REPORT_STATUS_RESOLVED,
	statusDismissed: appv1.ReportStatus_REPORT_STATUS_DISMISSED,
}

// IsOperator reports whether the user may use the moderation queue.
func (s *Service) IsOperator(userID int64) bool {
	return s.operators[userID]
}

func (s *Service) requireOperator(me int64) error {
	if !s.IsOperator(me) {
		return errDenied("moderation is for operators only")
	}
	return nil
}

// checkUnrestricted refuses a user whose account an operator restricted.
func (s *Service) checkUnrestricted(ctx context.Context, q querier, me int64) error {
	var restricted bool
	if err := q.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM account_restrictions WHERE user_id = $1 AND (until IS NULL OR until > now()))`,
		me).Scan(&restricted); err != nil {
		return fmt.Errorf("chat: check restriction: %w", err)
	}
	if restricted {
		return errDenied("account_restricted: your account is restricted by the operators")
	}
	return nil
}

func cleanNote(note string) (string, error) {
	note = strings.TrimSpace(strings.ToValidUTF8(note, ""))
	if note == "" {
		return "", errInvalid("note is required")
	}
	if utf8.RuneCountInString(note) > moderationNoteMax {
		return "", errInvalid("note is longer than %d characters", moderationNoteMax)
	}
	return note, nil
}

// reportRow is one row of reports.
type reportRow struct {
	ID, ReporterID, TargetUserID, TargetChatID int64
	Seqs                                       []int64
	Reason                                     int16
	Comment                                    string
	Evidence                                   []byte
	Status                                     string
	CreatedAt                                  time.Time
	ResolvedAt                                 *time.Time
	ResolvedBy                                 *string
	Actions                                    []string
	Note                                       string
}

const reportColumns = `id, reporter_id, target_user_id, target_chat_id, seqs, reason, comment, evidence, status,
	created_at, resolved_at, resolved_by, actions, resolution_note`

func scanReport(row pgx.Row) (*reportRow, error) {
	r := &reportRow{}
	err := row.Scan(&r.ID, &r.ReporterID, &r.TargetUserID, &r.TargetChatID, &r.Seqs, &r.Reason, &r.Comment, &r.Evidence,
		&r.Status, &r.CreatedAt, &r.ResolvedAt, &r.ResolvedBy, &r.Actions, &r.Note)
	return r, err
}

func (r *reportRow) kind() appv1.ReportTargetKind {
	switch {
	case len(r.Seqs) > 0:
		return appv1.ReportTargetKind_REPORT_TARGET_KIND_MESSAGES
	case r.TargetChatID != 0:
		return appv1.ReportTargetKind_REPORT_TARGET_KIND_CHAT
	default:
		return appv1.ReportTargetKind_REPORT_TARGET_KIND_USER
	}
}

func (r *reportRow) resolver() int64 {
	if r.ResolvedBy == nil {
		return 0
	}
	id, err := strconv.ParseInt(*r.ResolvedBy, 10, 64)
	if err != nil {
		return 0
	}
	return id
}

func (r *reportRow) render() *appv1.Report {
	out := &appv1.Report{
		Id: r.ID, TargetKind: r.kind(), ReporterId: r.ReporterID, TargetUserId: r.TargetUserID,
		TargetChatId: r.TargetChatID, Seqs: r.Seqs, Reason: appv1.ReportReason(r.Reason), Comment: r.Comment,
		Status: reportStatuses[r.Status], CreatedAt: r.CreatedAt.Unix(), ResolvedBy: r.resolver(),
		ResolutionNote: r.Note,
	}
	if r.ResolvedAt != nil {
		out.ResolvedAt = r.ResolvedAt.Unix()
	}
	for _, a := range r.Actions {
		out.Actions = append(out.Actions, actionOf(a))
	}
	return out
}

// evidenceItem is one reported message as copied when the report was filed.
type evidenceItem struct {
	Seq     int64  `json:"seq"`
	FromID  int64  `json:"from_id"`
	Date    int64  `json:"date"`
	Text    string `json:"text"`
	Deleted bool   `json:"deleted"`
}

func (r *reportRow) evidence() ([]evidenceItem, error) {
	var list []evidenceItem
	if len(r.Evidence) == 0 {
		return nil, nil
	}
	if err := json.Unmarshal(r.Evidence, &list); err != nil {
		return nil, fmt.Errorf("chat: report %d evidence: %w", r.ID, err)
	}
	return list, nil
}

// GetReports lists the tenant's reports, newest first. The cursor is the
// last report id returned.
func (s *Service) GetReports(ctx context.Context, me int64, req *appv1.GetReportsRequest) (*appv1.GetReportsResponse, error) {
	if err := s.requireOperator(me); err != nil {
		return nil, err
	}
	status := statusOpen
	switch req.GetStatus() {
	case appv1.ReportStatus_REPORT_STATUS_UNSPECIFIED, appv1.ReportStatus_REPORT_STATUS_OPEN:
	case appv1.ReportStatus_REPORT_STATUS_RESOLVED:
		status = statusResolved
	case appv1.ReportStatus_REPORT_STATUS_DISMISSED:
		status = statusDismissed
	default:
		return nil, errInvalid("unknown status")
	}
	kindCond := "true"
	switch req.GetTargetKind() {
	case appv1.ReportTargetKind_REPORT_TARGET_KIND_UNSPECIFIED:
	case appv1.ReportTargetKind_REPORT_TARGET_KIND_USER:
		kindCond = "target_user_id <> 0"
	case appv1.ReportTargetKind_REPORT_TARGET_KIND_CHAT:
		kindCond = "target_chat_id <> 0 AND cardinality(seqs) = 0"
	case appv1.ReportTargetKind_REPORT_TARGET_KIND_MESSAGES:
		kindCond = "cardinality(seqs) > 0"
	default:
		return nil, errInvalid("unknown target_kind")
	}
	if _, ok := appv1.ReportReason_name[int32(req.GetReason())]; !ok {
		return nil, errInvalid("unknown reason")
	}
	before := int64(1<<62 - 1)
	if c := req.GetCursor(); c != "" {
		v, err := strconv.ParseInt(c, 10, 64)
		if err != nil || v <= 0 {
			return nil, errInvalid("invalid cursor")
		}
		before = v
	}
	limit := pageLimit(req.GetLimit(), reportsPageDef, reportsPageMax)
	rows, err := s.pool.Query(ctx, `
		SELECT `+reportColumns+` FROM reports
		WHERE tenant_id = $1 AND status = $2 AND ($3 = 0 OR reason = $3) AND id < $4 AND `+kindCond+`
		ORDER BY id DESC LIMIT $5`, s.cfg.TenantID, status, int16(req.GetReason()), before, limit+1)
	if err != nil {
		return nil, fmt.Errorf("chat: list reports: %w", err)
	}
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (*reportRow, error) { return scanReport(r) })
	if err != nil {
		return nil, fmt.Errorf("chat: list reports: %w", err)
	}
	resp := &appv1.GetReportsResponse{}
	if len(list) > limit {
		list = list[:limit]
		resp.NextCursor = strconv.FormatInt(list[len(list)-1].ID, 10)
	}
	ents := newEntitySet()
	for _, r := range list {
		resp.Reports = append(resp.Reports, r.render())
		ents.addUsers(me, r.ReporterID, r.TargetUserID, r.resolver())
		ents.addChats(me, r.TargetChatID)
	}
	rendered, err := ents.render(ctx, s.pool, s.cfg.TenantID)
	if err != nil {
		return nil, err
	}
	resp.Users, resp.Chats = rendered.users[me], rendered.chats[me]
	return resp, nil
}

func (s *Service) loadReport(ctx context.Context, q querier, id int64, lock bool) (*reportRow, error) {
	if id <= 0 {
		return nil, errInvalid("report_id is required")
	}
	sql := `SELECT ` + reportColumns + ` FROM reports WHERE id = $1 AND tenant_id = $2`
	if lock {
		sql += ` FOR UPDATE`
	}
	r, err := scanReport(q.QueryRow(ctx, sql, id, s.cfg.TenantID))
	if isNoRows(err) {
		return nil, errNotFound("report")
	}
	if err != nil {
		return nil, fmt.Errorf("chat: load report: %w", err)
	}
	return r, nil
}

// reportedUsers are the users a report is about: the reported user, or the
// authors of the reported messages (as filed, and as stored now).
func (s *Service) reportedUsers(ctx context.Context, q querier, r *reportRow) ([]int64, error) {
	if r.TargetUserID != 0 {
		return []int64{r.TargetUserID}, nil
	}
	if len(r.Seqs) == 0 {
		return nil, nil
	}
	ev, err := r.evidence()
	if err != nil {
		return nil, err
	}
	var ids []int64
	for _, e := range ev {
		ids = append(ids, e.FromID)
	}
	msgs, err := loadMessages(ctx, q, map[int64][]int64{r.TargetChatID: r.Seqs})
	if err != nil {
		return nil, err
	}
	for _, m := range msgs {
		ids = append(ids, m.FromID)
	}
	return uniqueSorted(ids), nil
}

// GetReport returns one report with what an operator needs to decide.
func (s *Service) GetReport(ctx context.Context, me, reportID int64) (*appv1.GetReportResponse, error) {
	if err := s.requireOperator(me); err != nil {
		return nil, err
	}
	r, err := s.loadReport(ctx, s.pool, reportID, false)
	if err != nil {
		return nil, err
	}
	resp := &appv1.GetReportResponse{Report: r.render()}
	ents := newEntitySet()
	ents.addUsers(me, r.ReporterID, r.TargetUserID, r.resolver())
	ev, err := r.evidence()
	if err != nil {
		return nil, err
	}
	for _, e := range ev {
		resp.Evidence = append(resp.Evidence, &appv1.ReportedMessage{Seq: e.Seq, FromId: e.FromID, Date: e.Date, Text: e.Text, Deleted: e.Deleted})
		ents.addUsers(me, e.FromID)
	}
	if len(r.Seqs) > 0 {
		rows, err := s.pool.Query(ctx, `
			(SELECT `+messageColumns+` FROM messages m WHERE m.chat_id = $1 AND m.seq < $2 ORDER BY m.seq DESC LIMIT $5)
			UNION ALL
			(SELECT `+messageColumns+` FROM messages m WHERE m.chat_id = $1 AND m.seq = ANY($4))
			UNION ALL
			(SELECT `+messageColumns+` FROM messages m WHERE m.chat_id = $1 AND m.seq > $3 ORDER BY m.seq LIMIT $5)`,
			r.TargetChatID, slices.Min(r.Seqs), slices.Max(r.Seqs), r.Seqs, contextAround)
		if err != nil {
			return nil, fmt.Errorf("chat: report context: %w", err)
		}
		list, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (*messageRow, error) { return scanMessage(row) })
		if err != nil {
			return nil, fmt.Errorf("chat: report context: %w", err)
		}
		slices.SortFunc(list, func(a, b *messageRow) int { return cmp.Compare(a.Seq, b.Seq) })
		msgs, users, err := s.renderMessages(ctx, s.pool, me, list)
		if err != nil {
			return nil, err
		}
		resp.Context = msgs
		for _, u := range users {
			ents.addUsers(me, u.GetId())
		}
	}
	if r.TargetChatID != 0 {
		ents.addChats(me, r.TargetChatID)
	}
	targets, err := s.reportedUsers(ctx, s.pool, r)
	if err != nil {
		return nil, err
	}
	ents.addUsers(me, targets...)
	if len(targets) > 0 {
		if resp.History, err = s.moderationHistory(ctx, targets); err != nil {
			return nil, err
		}
		for _, h := range resp.History {
			ents.addUsers(me, h.GetOperatorId())
		}
		if resp.Restrictions, err = s.activeRestrictions(ctx, targets); err != nil {
			return nil, err
		}
	}
	rendered, err := ents.render(ctx, s.pool, s.cfg.TenantID)
	if err != nil {
		return nil, err
	}
	resp.Users = rendered.users[me]
	if chats := rendered.chats[me]; len(chats) > 0 {
		resp.Chat = chats[0]
	}
	return resp, nil
}

func (s *Service) moderationHistory(ctx context.Context, users []int64) ([]*appv1.ModerationLogEntry, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, operator_id, report_id, action, target_user_id, target_chat_id, note, until, created_at
		FROM moderation_log WHERE tenant_id = $1 AND target_user_id = ANY($2) ORDER BY id DESC LIMIT $3`,
		s.cfg.TenantID, users, historyMax)
	if err != nil {
		return nil, fmt.Errorf("chat: moderation history: %w", err)
	}
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (*appv1.ModerationLogEntry, error) {
		e := &appv1.ModerationLogEntry{}
		var action string
		var until *time.Time
		var at time.Time
		err := r.Scan(&e.Id, &e.OperatorId, &e.ReportId, &action, &e.TargetUserId, &e.TargetChatId, &e.Note, &until, &at)
		e.Action, e.CreatedAt = actionOf(action), at.Unix()
		if until != nil {
			e.Until = until.Unix()
		}
		return e, err
	})
	if err != nil {
		return nil, fmt.Errorf("chat: moderation history: %w", err)
	}
	return list, nil
}

func (s *Service) activeRestrictions(ctx context.Context, users []int64) ([]*appv1.AccountRestriction, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT user_id, until, reason, created_at FROM account_restrictions
		WHERE tenant_id = $1 AND user_id = ANY($2) AND (until IS NULL OR until > now()) ORDER BY user_id`,
		s.cfg.TenantID, users)
	if err != nil {
		return nil, fmt.Errorf("chat: restrictions: %w", err)
	}
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (*appv1.AccountRestriction, error) {
		a := &appv1.AccountRestriction{}
		var until *time.Time
		var at time.Time
		err := r.Scan(&a.UserId, &until, &a.Reason, &at)
		a.CreatedAt = at.Unix()
		if until != nil {
			a.Until = until.Unix()
		}
		return a, err
	})
	if err != nil {
		return nil, fmt.Errorf("chat: restrictions: %w", err)
	}
	return list, nil
}

// logModeration appends one entry to the moderation log.
func (t *txn) logModeration(ctx context.Context, operator, reportID int64, action appv1.ModerationAction,
	userID, chatID int64, seqs []int64, note string, until *time.Time,
) error {
	if seqs == nil {
		seqs = []int64{}
	}
	if _, err := t.tx.Exec(ctx, `
		INSERT INTO moderation_log (tenant_id, operator_id, report_id, action, target_user_id, target_chat_id, seqs, note, until)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		t.s.cfg.TenantID, operator, reportID, actionNames[action], userID, chatID, seqs, note, until); err != nil {
		return fmt.Errorf("chat: moderation log: %w", err)
	}
	return nil
}

// cleanActions validates the actions of a resolution: known, no
// duplicates, dismiss alone.
func cleanActions(actions []appv1.ModerationAction) ([]appv1.ModerationAction, error) {
	if len(actions) == 0 {
		return nil, errInvalid("at least one action is required")
	}
	out := slices.Clone(actions)
	slices.Sort(out)
	out = slices.Compact(out)
	for _, a := range out {
		if _, ok := actionNames[a]; !ok || a == appv1.ModerationAction_MODERATION_ACTION_LIFT_RESTRICTION {
			return nil, errInvalid("unknown action")
		}
	}
	if slices.Contains(out, appv1.ModerationAction_MODERATION_ACTION_DISMISS) && len(out) > 1 {
		return nil, errInvalid("dismiss cannot be combined with other actions")
	}
	return out, nil
}

// ResolveReport closes an open report with the given actions.
func (s *Service) ResolveReport(ctx context.Context, me int64, req *appv1.ResolveReportRequest) (*appv1.ResolveReportResponse, error) {
	if err := s.requireOperator(me); err != nil {
		return nil, err
	}
	actions, err := cleanActions(req.GetActions())
	if err != nil {
		return nil, err
	}
	note, err := cleanNote(req.GetNote())
	if err != nil {
		return nil, err
	}
	if req.GetRestrictSeconds() < 0 || req.GetRestrictSeconds() > restrictMaxSeconds {
		return nil, errInvalid("restrict_seconds must be 0 to %d", restrictMaxSeconds)
	}
	if err := s.allow(limitWrite, "write", me); err != nil {
		return nil, err
	}
	_, err = s.inTx(ctx, func(t *txn) error {
		r, err := s.loadReport(ctx, t.tx, req.GetReportId(), true)
		if err != nil {
			return err
		}
		if r.Status != statusOpen {
			return errPrecondition("report_closed: this report was already closed")
		}
		targets, err := s.reportedUsers(ctx, t.tx, r)
		if err != nil {
			return err
		}
		names := make([]string, 0, len(actions))
		for _, a := range actions {
			names = append(names, actionNames[a])
			if err := t.applyModeration(ctx, me, r, a, targets, note, req.GetRestrictSeconds()); err != nil {
				return err
			}
		}
		status := statusResolved
		if actions[0] == appv1.ModerationAction_MODERATION_ACTION_DISMISS {
			status = statusDismissed
		}
		if _, err := t.tx.Exec(ctx, `
			UPDATE reports SET status = $2, resolved_at = now(), resolved_by = $3, actions = $4, resolution_note = $5
			WHERE id = $1`, r.ID, status, strconv.FormatInt(me, 10), names, note); err != nil {
			return fmt.Errorf("chat: close report: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	r, err := s.loadReport(ctx, s.pool, req.GetReportId(), false)
	if err != nil {
		return nil, err
	}
	s.logger.Info("report resolved", "report_id", r.ID, "operator_id", me, "actions", r.Actions)
	return &appv1.ResolveReportResponse{Report: r.render()}, nil
}

// applyModeration carries out one action of a resolution.
func (t *txn) applyModeration(ctx context.Context, me int64, r *reportRow, action appv1.ModerationAction,
	targets []int64, note string, restrictSeconds int32,
) error {
	switch action {
	case appv1.ModerationAction_MODERATION_ACTION_DISMISS:
		return t.logModeration(ctx, me, r.ID, action, r.TargetUserID, r.TargetChatID, r.Seqs, note, nil)
	case appv1.ModerationAction_MODERATION_ACTION_DELETE_MESSAGES:
		if len(r.Seqs) == 0 {
			return errInvalid("delete_messages needs a report about messages")
		}
		c, err := t.lockChat(ctx, r.TargetChatID)
		if err != nil {
			return err
		}
		if c != nil {
			if err := t.deleteMessages(ctx, c, true, me, r.Seqs); err != nil {
				return err
			}
		}
		return t.logModeration(ctx, me, r.ID, action, 0, r.TargetChatID, r.Seqs, note, nil)
	case appv1.ModerationAction_MODERATION_ACTION_BAN_FROM_CHAT:
		if len(r.Seqs) == 0 {
			return errInvalid("ban_from_chat needs a report about messages")
		}
		c, err := t.lockChat(ctx, r.TargetChatID)
		if err != nil || c == nil {
			return err
		}
		if c.Type == typePrivate {
			return errInvalid("nobody can be banned from a private chat")
		}
		for _, uid := range targets {
			if err := t.banByModeration(ctx, c, uid); err != nil {
				return err
			}
			if err := t.logModeration(ctx, me, r.ID, action, uid, c.ID, nil, note, nil); err != nil {
				return err
			}
		}
		return nil
	case appv1.ModerationAction_MODERATION_ACTION_RESTRICT_ACCOUNT:
		if len(targets) == 0 {
			return errInvalid("restrict_account needs a report about a user or messages")
		}
		var until *time.Time
		if restrictSeconds > 0 {
			u := time.Now().Add(time.Duration(restrictSeconds) * time.Second)
			until = &u
		}
		for _, uid := range targets {
			if uid == me {
				return errInvalid("you cannot restrict your own account")
			}
			if err := t.restrict(ctx, me, r.ID, uid, until, note); err != nil {
				return err
			}
			if err := t.logModeration(ctx, me, r.ID, action, uid, r.TargetChatID, nil, note, until); err != nil {
				return err
			}
		}
		return nil
	default:
		return errInvalid("unknown action")
	}
}

// lockChat locks a chat of the tenant for a moderation action; nil when
// it no longer exists (deleted by its owner).
func (t *txn) lockChat(ctx context.Context, chatID int64) (*chatRow, error) {
	c, err := scanChat(t.tx.QueryRow(ctx, `SELECT `+chatColumns+` FROM `+chatFrom+`
		WHERE c.id = $1 AND c.tenant_id = $2 AND c.deleted_at IS NULL FOR UPDATE OF c`, chatID, t.s.cfg.TenantID))
	if isNoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("chat: load chat: %w", err)
	}
	return c, nil
}

// banByModeration removes a member from a locked chat and bans them (a
// former member is only banned); the owner is refused.
func (t *txn) banByModeration(ctx context.Context, c *chatRow, userID int64) error {
	m, err := t.s.memberRow(ctx, t.tx, c.ID, userID)
	if isNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if m.active() && m.Role == roleOwner {
		return errInvalid("the owner cannot be banned from their chat; restrict the account instead")
	}
	if _, err := t.tx.Exec(ctx, `
		UPDATE invite_links SET revoked_at = now() WHERE chat_id = $1 AND creator_id = $2 AND revoked_at IS NULL`,
		c.ID, userID); err != nil {
		return fmt.Errorf("chat: revoke the member's invite links: %w", err)
	}
	if m.active() {
		return t.removeMember(ctx, c, 0, userID, true)
	}
	if _, err := t.tx.Exec(ctx, `
		UPDATE chat_members SET banned_at = now(), banned_by = 0 WHERE chat_id = $1 AND user_id = $2 AND banned_at IS NULL`,
		c.ID, userID); err != nil {
		return fmt.Errorf("chat: ban former member: %w", err)
	}
	return nil
}

// restrict records an account restriction and revokes the user's chat
// sessions (their sockets close through the outbox).
func (t *txn) restrict(ctx context.Context, me, reportID, userID int64, until *time.Time, note string) error {
	tag, err := t.tx.Exec(ctx, `
		INSERT INTO account_restrictions (user_id, tenant_id, until, reason, restricted_by, report_id)
		SELECT id, $2, $3, $4, $5, $6 FROM users WHERE id = $1 AND tenant_id = $2
		ON CONFLICT (user_id) DO UPDATE SET until = excluded.until, reason = excluded.reason,
			restricted_by = excluded.restricted_by, report_id = excluded.report_id, created_at = now()`,
		userID, t.s.cfg.TenantID, until, note, me, reportID)
	if err != nil {
		return fmt.Errorf("chat: restrict account: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return errNotFound("user")
	}
	if _, err := t.tx.Exec(ctx, `
		UPDATE user_sessions SET revoked_at = now(), refresh_token_enc = NULL, id_token_enc = NULL, revoke_reason = $3
		WHERE user_id = $1 AND tenant_id = $2 AND revoked_at IS NULL`, userID, t.s.cfg.TenantID, reasonAdmin); err != nil {
		return fmt.Errorf("chat: revoke restricted sessions: %w", err)
	}
	return nil
}

// LiftRestriction ends a user's account restriction.
func (s *Service) LiftRestriction(ctx context.Context, me, userID int64, note string) error {
	if err := s.requireOperator(me); err != nil {
		return err
	}
	note, err := cleanNote(note)
	if err != nil {
		return err
	}
	if userID <= 0 {
		return errInvalid("user_id is required")
	}
	_, err = s.inTx(ctx, func(t *txn) error {
		tag, err := t.tx.Exec(ctx, `
			DELETE FROM account_restrictions WHERE user_id = $1 AND tenant_id = $2 AND (until IS NULL OR until > now())`,
			userID, s.cfg.TenantID)
		if err != nil {
			return fmt.Errorf("chat: lift restriction: %w", err)
		}
		if tag.RowsAffected() == 0 {
			return errNotFound("restriction")
		}
		return t.logModeration(ctx, me, 0, appv1.ModerationAction_MODERATION_ACTION_LIFT_RESTRICTION, userID, 0, nil, note, nil)
	})
	return err
}
