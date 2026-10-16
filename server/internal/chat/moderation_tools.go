package chat

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/proto"
)

// The moderation tools around the queue: reports grouped by target, what
// an operator sees about a group and its users, the log, webhooks, and the
// notices users get about decisions.

const (
	logPageDef      = 50
	logPageMax      = 500
	groupCommentMax = 10
)

// ----------------------------------------------------------------- notices

// Notifier tells users what the moderation team decided about them (the
// tenant's assistant bot). A failure is logged; the decision stands.
type Notifier interface {
	NotifyModeration(ctx context.Context, userID int64, n ModerationNotice) error
}

// ModerationNotice is one decision as told to a user.
type ModerationNotice struct {
	Actions []appv1.ModerationAction
	// Note is the operator's reason.
	Note string
	// Until ends an account restriction; zero means until lifted.
	Until time.Time
}

type moderationNotice struct {
	ModerationNotice
	users []int64
}

// SetNotifier registers who tells users about moderation decisions.
func (s *Service) SetNotifier(n Notifier) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.notifier = n
}

func (s *Service) sendNotice(ctx context.Context, n moderationNotice) {
	if len(n.users) == 0 {
		return
	}
	s.mu.RLock()
	notifier := s.notifier
	s.mu.RUnlock()
	if notifier == nil {
		s.logger.Warn("moderation notice not sent: no notifier", "users", len(n.users))
		return
	}
	for _, uid := range n.users {
		if err := notifier.NotifyModeration(ctx, uid, n.ModerationNotice); err != nil {
			s.logger.Warn("moderation notice failed", "user_id", uid, "err", err)
		}
	}
}

// humansOf keeps the ids of people (not bots) among ids.
func humansOf(ctx context.Context, q querier, ids []int64) ([]int64, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	rows, err := q.Query(ctx, `SELECT id FROM users WHERE id = ANY($1) AND NOT is_bot ORDER BY id`, ids)
	if err != nil {
		return nil, fmt.Errorf("chat: notice users: %w", err)
	}
	out, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return nil, fmt.Errorf("chat: notice users: %w", err)
	}
	return out, nil
}

// --------------------------------------------------------------------- log

// moderationEntry is one row of moderation_log; operator 0 is an automatic rule.
type moderationEntry struct {
	operator, reportID int64
	action             appv1.ModerationAction
	userID, chatID     int64
	seqs               []int64
	note               string
	until              *time.Time
	hookID             string
}

func insertLog(ctx context.Context, q querier, tenantID string, e moderationEntry) error {
	if e.seqs == nil {
		e.seqs = []int64{}
	}
	if _, err := q.Exec(ctx, `
		INSERT INTO moderation_log (tenant_id, operator_id, report_id, action, target_user_id, target_chat_id, seqs, note, until, hook_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		tenantID, e.operator, e.reportID, actionNames[e.action], e.userID, e.chatID, e.seqs, e.note, e.until, e.hookID); err != nil {
		return fmt.Errorf("chat: moderation log: %w", err)
	}
	return nil
}

const logColumns = `id, operator_id, report_id, action, target_user_id, target_chat_id, note, until, created_at, seqs, hook_id`

func scanLogEntry(r pgx.CollectableRow) (*appv1.ModerationLogEntry, error) {
	e := &appv1.ModerationLogEntry{}
	var action string
	var until *time.Time
	var at time.Time
	err := r.Scan(&e.Id, &e.OperatorId, &e.ReportId, &action, &e.TargetUserId, &e.TargetChatId, &e.Note, &until, &at,
		&e.Seqs, &e.HookId)
	e.Action, e.CreatedAt = actionOf(action), at.Unix()
	if until != nil {
		e.Until = until.Unix()
	}
	return e, err
}

// GetModerationLog lists the tenant's moderation log, newest first. The
// cursor is the last entry id returned.
func (s *Service) GetModerationLog(ctx context.Context, me int64, req *appv1.GetModerationLogRequest) (*appv1.GetModerationLogResponse, error) {
	if err := s.requireOperator(me); err != nil {
		return nil, err
	}
	action := ""
	if a := req.GetAction(); a != appv1.ModerationAction_MODERATION_ACTION_UNSPECIFIED {
		name, ok := actionNames[a]
		if !ok {
			return nil, errInvalid("unknown action")
		}
		action = name
	}
	if req.GetOperatorId() < 0 || req.GetSince() < 0 {
		return nil, errInvalid("operator_id and since cannot be negative")
	}
	before := int64(1<<62 - 1)
	if c := req.GetCursor(); c != "" {
		v, err := strconv.ParseInt(c, 10, 64)
		if err != nil || v <= 0 {
			return nil, errInvalid("invalid cursor")
		}
		before = v
	}
	limit := pageLimit(req.GetLimit(), logPageDef, logPageMax)
	rows, err := s.pool.Query(ctx, `
		SELECT `+logColumns+` FROM moderation_log
		WHERE tenant_id = $1 AND id < $2 AND ($3 = '' OR action = $3)
			AND ($4::bigint = 0 OR operator_id = $4::bigint) AND (NOT $5 OR operator_id = 0)
			AND ($6::bigint = 0 OR created_at >= to_timestamp($6::bigint))
		ORDER BY id DESC LIMIT $7`,
		s.cfg.TenantID, before, action, req.GetOperatorId(), req.GetAutomaticOnly(), req.GetSince(), limit+1)
	if err != nil {
		return nil, fmt.Errorf("chat: moderation log: %w", err)
	}
	list, err := pgx.CollectRows(rows, scanLogEntry)
	if err != nil {
		return nil, fmt.Errorf("chat: moderation log: %w", err)
	}
	resp := &appv1.GetModerationLogResponse{}
	if len(list) > limit {
		list = list[:limit]
		resp.NextCursor = strconv.FormatInt(list[len(list)-1].GetId(), 10)
	}
	ents := newEntitySet()
	for _, e := range list {
		ents.addUsers(me, e.GetOperatorId(), e.GetTargetUserId())
		ents.addChats(me, e.GetTargetChatId())
	}
	rendered, err := ents.render(ctx, s.pool, s.cfg.TenantID)
	if err != nil {
		return nil, err
	}
	resp.Entries, resp.Users, resp.Chats = list, rendered.users[me], rendered.chats[me]
	return resp, nil
}

// ------------------------------------------------------------------ groups

// GetReportGroups lists the reports grouped by target, the groups with the
// most reports first, then the newest. The cursor is "count:newest id" of
// the last group returned.
func (s *Service) GetReportGroups(ctx context.Context, me int64, req *appv1.GetReportGroupsRequest) (*appv1.GetReportGroupsResponse, error) {
	if err := s.requireOperator(me); err != nil {
		return nil, err
	}
	status, err := reportStatusOf(req.GetStatus())
	if err != nil {
		return nil, err
	}
	kindCond, err := kindCondition(req.GetTargetKind())
	if err != nil {
		return nil, err
	}
	if _, ok := appv1.ReportReason_name[int32(req.GetReason())]; !ok {
		return nil, errInvalid("unknown reason")
	}
	afterCount, afterID := int64(1<<31-1), int64(1<<62-1)
	if c := req.GetCursor(); c != "" {
		count, id, ok := strings.Cut(c, ":")
		n, err1 := strconv.ParseInt(count, 10, 32)
		v, err2 := strconv.ParseInt(id, 10, 64)
		if !ok || err1 != nil || err2 != nil || n <= 0 || v <= 0 {
			return nil, errInvalid("invalid cursor")
		}
		afterCount, afterID = n, v
	}
	limit := pageLimit(req.GetLimit(), reportsPageDef, reportsPageMax)
	rows, err := s.pool.Query(ctx, `
		WITH g AS (
			SELECT r.target_user_id, r.target_chat_id, r.seqs, max(r.id) AS newest, count(*) AS n,
				mode() WITHIN GROUP (ORDER BY r.reason) AS main
			FROM reports r
			WHERE r.tenant_id = $1 AND r.status = $2 AND ($3 = 0 OR r.reason = $3) AND `+kindCond+`
			GROUP BY 1, 2, 3)
		SELECT `+reportColumns+`, g.n, g.main FROM g JOIN reports r ON r.id = g.newest
		WHERE (g.n, g.newest) < ($4, $5)
		ORDER BY g.n DESC, g.newest DESC LIMIT $6`,
		s.cfg.TenantID, status, int16(req.GetReason()), afterCount, afterID, limit+1)
	if err != nil {
		return nil, fmt.Errorf("chat: report groups: %w", err)
	}
	type groupRow struct {
		report *reportRow
		count  int64
		main   int16
	}
	list, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (groupRow, error) {
		var g groupRow
		var err error
		g.report, err = scanReport(row, &g.count, &g.main)
		return g, err
	})
	if err != nil {
		return nil, fmt.Errorf("chat: report groups: %w", err)
	}
	resp := &appv1.GetReportGroupsResponse{}
	if len(list) > limit {
		list = list[:limit]
		last := list[len(list)-1]
		resp.NextCursor = fmt.Sprintf("%d:%d", last.count, last.report.ID)
	}
	ents := newEntitySet()
	for _, g := range list {
		r := g.report
		resp.Groups = append(resp.Groups, &appv1.ReportGroup{
			Report: r.render(), ReportCount: int32(g.count), MainReason: appv1.ReportReason(g.main),
		})
		ents.addUsers(me, r.ReporterID, r.TargetUserID, r.resolver())
		ents.addChats(me, r.TargetChatID)
		ev, err := r.evidence()
		if err != nil {
			return nil, err
		}
		for _, e := range ev {
			ents.addUsers(me, e.FromID)
		}
	}
	rendered, err := ents.render(ctx, s.pool, s.cfg.TenantID)
	if err != nil {
		return nil, err
	}
	resp.Users, resp.Chats = rendered.users[me], rendered.chats[me]
	return resp, nil
}

// groupSummary sums up the reports about the same target as r with its
// status.
func (s *Service) groupSummary(ctx context.Context, r *reportRow) (*appv1.ReportGroupSummary, error) {
	out := &appv1.ReportGroupSummary{}
	rows, err := s.pool.Query(ctx, `
		SELECT r.reason, count(*) FROM reports r WHERE r.tenant_id = $2 AND r.status = $3 AND `+sameTargetSQL+`
		GROUP BY r.reason ORDER BY 2 DESC, 1`, r.ID, s.cfg.TenantID, r.Status)
	if err != nil {
		return nil, fmt.Errorf("chat: report group: %w", err)
	}
	reasons, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (*appv1.ReasonCount, error) {
		var reason int16
		c := &appv1.ReasonCount{}
		err := row.Scan(&reason, &c.Count)
		c.Reason = appv1.ReportReason(reason)
		return c, err
	})
	if err != nil {
		return nil, fmt.Errorf("chat: report group: %w", err)
	}
	out.Reasons = reasons
	if err := s.pool.QueryRow(ctx, `
		SELECT count(*), count(DISTINCT r.reporter_id) FROM reports r
		WHERE r.tenant_id = $2 AND r.status = $3 AND `+sameTargetSQL, r.ID, s.cfg.TenantID, r.Status).
		Scan(&out.ReportCount, &out.ReporterCount); err != nil {
		return nil, fmt.Errorf("chat: report group: %w", err)
	}
	rows, err = s.pool.Query(ctx, `
		SELECT r.comment FROM reports r WHERE r.tenant_id = $2 AND r.status = $3 AND r.comment <> '' AND `+sameTargetSQL+`
		ORDER BY r.id DESC LIMIT $4`, r.ID, s.cfg.TenantID, r.Status, groupCommentMax)
	if err != nil {
		return nil, fmt.Errorf("chat: report comments: %w", err)
	}
	if out.Comments, err = pgx.CollectRows(rows, pgx.RowTo[string]); err != nil {
		return nil, fmt.Errorf("chat: report comments: %w", err)
	}
	return out, nil
}

// senderSignals sums up what each of users did lately; reportID's group is
// left out of their other open reports.
func (s *Service) senderSignals(ctx context.Context, users []int64, reportID int64) ([]*appv1.SenderSignals, error) {
	var out []*appv1.SenderSignals
	for _, uid := range users {
		sig := &appv1.SenderSignals{UserId: uid}
		var age time.Duration
		err := s.pool.QueryRow(ctx, `
			SELECT now() - u.created_at,
				`+strangerChats24hSQL+`,
				(SELECT count(*) FROM blocks b WHERE b.blocked_id = $1),
				(SELECT count(*) FROM chat_members m JOIN chats c ON c.id = m.chat_id
				WHERE m.user_id = $1 AND c.type IN ('group', 'channel') AND m.joined_at > now() - interval '24 hours'),
				(SELECT count(*) FROM reports r WHERE r.tenant_id = $2 AND r.status = 'open'
					AND (r.target_user_id = $1 OR r.evidence @> jsonb_build_array(jsonb_build_object('from_id', $1::bigint)))
					AND NOT EXISTS (SELECT 1 FROM reports g WHERE g.id = $3
						AND (g.target_user_id, g.target_chat_id, g.seqs) = (r.target_user_id, r.target_chat_id, r.seqs)))
			FROM users u WHERE u.id = $1 AND u.tenant_id = $2`, uid, s.cfg.TenantID, reportID).
			Scan(&age, &sig.StrangerChats_24H, &sig.BlockedBy, &sig.ChatsJoined_24H, &sig.OtherOpenReports)
		if isNoRows(err) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("chat: sender signals: %w", err)
		}
		sig.AccountAgeSeconds = int64(age.Seconds())
		out = append(out, sig)
	}
	return out, nil
}

// ---------------------------------------------------------------- webhooks

// isIntegration reports whether m was posted by an incoming webhook (a
// service message has from_id 0 too, but no integration label).
func isIntegration(m *messageRow) bool {
	if len(m.Content) == 0 {
		return false
	}
	content := &appv1.Message{}
	return proto.Unmarshal(m.Content, content) == nil && content.GetIntegrationLabel() != ""
}

// reportedHookIDs are the hooks that posted the webhook messages of report
// r: from hook_posts, and for messages posted before it was kept, the
// chat's only hook named like the message's label (none when the name is
// ambiguous).
func reportedHookIDs(ctx context.Context, q querier, tenantID string, r *reportRow) ([]string, error) {
	rows, err := q.Query(ctx, `SELECT seq, hook_id FROM hook_posts WHERE chat_id = $1 AND seq = ANY($2)`, r.TargetChatID, r.Seqs)
	if err != nil {
		return nil, fmt.Errorf("chat: hook posts: %w", err)
	}
	type post struct {
		seq  int64
		hook string
	}
	posts, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (post, error) {
		var p post
		return p, row.Scan(&p.seq, &p.hook)
	})
	if err != nil {
		return nil, fmt.Errorf("chat: hook posts: %w", err)
	}
	seen := map[string]bool{}
	known := map[int64]bool{}
	var ids []string
	add := func(id string) {
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	for _, p := range posts {
		known[p.seq] = true
		add(p.hook)
	}
	var older []int64
	for _, seq := range r.Seqs {
		if !known[seq] {
			older = append(older, seq)
		}
	}
	if len(older) == 0 {
		return ids, nil
	}
	msgs, err := loadMessages(ctx, q, map[int64][]int64{r.TargetChatID: older})
	if err != nil {
		return nil, err
	}
	for _, m := range msgs {
		if m.FromID != 0 || len(m.Content) == 0 {
			continue
		}
		content := &appv1.Message{}
		if err := proto.Unmarshal(m.Content, content); err != nil || content.GetIntegrationLabel() == "" {
			continue
		}
		rows, err := q.Query(ctx, `SELECT id FROM incoming_hooks WHERE tenant_id = $1 AND chat_id = $2 AND name = $3`,
			tenantID, r.TargetChatID, content.GetIntegrationLabel())
		if err != nil {
			return nil, fmt.Errorf("chat: hooks by name: %w", err)
		}
		named, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return nil, fmt.Errorf("chat: hooks by name: %w", err)
		}
		if len(named) == 1 {
			add(named[0])
		}
	}
	return ids, nil
}

// reportedHooks are the hooks DISABLE_WEBHOOK turns off for report r.
func (s *Service) reportedHooks(ctx context.Context, r *reportRow) ([]*appv1.ModeratedHook, error) {
	ids, err := reportedHookIDs(ctx, s.pool, s.cfg.TenantID, r)
	if err != nil || len(ids) == 0 {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id, name, state <> 'active' FROM incoming_hooks WHERE tenant_id = $1 AND chat_id = $2 AND id = ANY($3)
		ORDER BY name, id`, s.cfg.TenantID, r.TargetChatID, ids)
	if err != nil {
		return nil, fmt.Errorf("chat: reported hooks: %w", err)
	}
	list, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (*appv1.ModeratedHook, error) {
		h := &appv1.ModeratedHook{}
		return h, row.Scan(&h.Id, &h.Name, &h.Disabled)
	})
	if err != nil {
		return nil, fmt.Errorf("chat: reported hooks: %w", err)
	}
	return list, nil
}

// disableReportedHooks turns off the hooks that posted the messages of
// report r (by_moderator: chat admins cannot turn them back on). The group
// sees the service message "turned off by the moderation team" and the
// hook's audit says so, without naming the operator.
func (t *txn) disableReportedHooks(ctx context.Context, me int64, r *reportRow, note string) error {
	ids, err := reportedHookIDs(ctx, t.tx, t.s.cfg.TenantID, r)
	if err != nil {
		return err
	}
	c, err := t.lockChat(ctx, r.TargetChatID)
	if err != nil {
		return err
	}
	var exists bool
	if c != nil && len(ids) > 0 {
		if err := t.tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM incoming_hooks WHERE tenant_id = $1 AND chat_id = $2 AND id = ANY($3))`,
			t.s.cfg.TenantID, c.ID, ids).Scan(&exists); err != nil {
			return fmt.Errorf("chat: find reported hooks: %w", err)
		}
	}
	if !exists {
		return errPrecondition("no_webhook: the webhook that posted these messages is gone")
	}
	rows, err := t.tx.Query(ctx, `
		UPDATE incoming_hooks SET state = 'disabled', disabled_reason = 'by_moderator', disabled_at = now(), updated_at = now()
		WHERE tenant_id = $1 AND chat_id = $2 AND id = ANY($3) AND NOT (state = 'disabled' AND disabled_reason = 'by_moderator')
		RETURNING id, name`, t.s.cfg.TenantID, c.ID, ids)
	if err != nil {
		return fmt.Errorf("chat: disable reported hooks: %w", err)
	}
	type hook struct{ id, name string }
	hooks, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (hook, error) {
		var h hook
		return h, row.Scan(&h.id, &h.name)
	})
	if err != nil {
		return fmt.Errorf("chat: disable reported hooks: %w", err)
	}
	for _, h := range hooks {
		if _, err := t.tx.Exec(ctx, `
			INSERT INTO hook_audit (tenant_id, chat_id, hook_id, hook_name, actor_id, action, detail)
			VALUES ($1, $2, $3, $4, 0, 'disabled', 'by_moderator')`, t.s.cfg.TenantID, c.ID, h.id, h.name); err != nil {
			return fmt.Errorf("chat: hook audit: %w", err)
		}
		if err := t.hookStopped(ctx, c, 0, h.name, appv1.IncomingHookStopReason_INCOMING_HOOK_STOP_REASON_BY_MODERATOR); err != nil {
			return err
		}
		if err := insertLog(ctx, t.tx, t.s.cfg.TenantID, moderationEntry{
			operator: me, reportID: r.ID, action: appv1.ModerationAction_MODERATION_ACTION_DISABLE_WEBHOOK,
			chatID: c.ID, seqs: r.Seqs, note: note, hookID: h.id,
		}); err != nil {
			return err
		}
	}
	return nil
}
