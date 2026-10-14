package chat

import (
	"context"
	"slices"
	"strings"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"connectrpc.com/connect"
)

// moderationSetup is a group where spammer posted between two ordinary
// messages and reporter reported the spam.
type moderationSetup struct {
	h                                *harness
	operator, reporter, spammer, own int64
	chatID, spam                     int64
	reportID                         int64
}

func newModerationSetup(t *testing.T) *moderationSetup {
	t.Helper()
	var operator int64
	h := newHarness(t, nil)
	operator = h.user("operator")
	// Recreate the service with the operator configured.
	h = newHarnessOn(t, h.st, testTenant, func(c *Config) { c.Operators = []int64{operator} })
	ctx := context.Background()
	m := &moderationSetup{h: h, operator: operator}
	m.own, m.reporter, m.spammer = h.user("owner"), h.user("reporter"), h.user("spammer")
	m.chatID = h.group(m.own, m.reporter, m.spammer)
	for i := range 7 {
		h.send(m.reporter, m.chatID, "before "+string(rune('a'+i)))
	}
	m.spam = h.send(m.spammer, m.chatID, "win a phone at evil.example").GetMessage().GetSeq()
	h.send(m.reporter, m.chatID, "that is a scam")
	if err := h.svc.Report(ctx, m.reporter, &appv1.ReportRequest{
		Target: &appv1.ReportRequest_Messages{Messages: &appv1.ReportedMessages{ChatId: m.chatID, Seqs: []int64{m.spam}}},
		Reason: appv1.ReportReason_REPORT_REASON_SCAM, Comment: "fake prize",
	}); err != nil {
		t.Fatal(err)
	}
	if err := h.svc.Report(ctx, m.reporter, &appv1.ReportRequest{
		Target: &appv1.ReportRequest_UserId{UserId: m.spammer}, Reason: appv1.ReportReason_REPORT_REASON_SPAM,
	}); err != nil {
		t.Fatal(err)
	}
	list, err := h.svc.GetReports(ctx, operator, &appv1.GetReportsRequest{TargetKind: appv1.ReportTargetKind_REPORT_TARGET_KIND_MESSAGES})
	if err != nil || len(list.GetReports()) != 1 {
		t.Fatalf("message reports = %v, %v", list, err)
	}
	m.reportID = list.GetReports()[0].GetId()
	return m
}

func TestModerationOnlyForOperators(t *testing.T) {
	m := newModerationSetup(t)
	h, ctx := m.h, context.Background()
	if h.svc.IsOperator(m.reporter) || !h.svc.IsOperator(m.operator) {
		t.Fatal("operator set wrong")
	}
	for _, who := range []int64{m.reporter, m.own, m.spammer} {
		if _, err := h.svc.GetReports(ctx, who, &appv1.GetReportsRequest{}); codeOf(err) != connect.CodePermissionDenied {
			t.Fatalf("GetReports by %d: %v", who, err)
		}
		if _, err := h.svc.GetReport(ctx, who, m.reportID); codeOf(err) != connect.CodePermissionDenied {
			t.Fatalf("GetReport by %d: %v", who, err)
		}
		if _, err := h.svc.ResolveReport(ctx, who, &appv1.ResolveReportRequest{
			ReportId: m.reportID, Actions: []appv1.ModerationAction{appv1.ModerationAction_MODERATION_ACTION_DISMISS}, Note: "x",
		}); codeOf(err) != connect.CodePermissionDenied {
			t.Fatalf("ResolveReport by %d: %v", who, err)
		}
		if err := h.svc.LiftRestriction(ctx, who, m.spammer, "x"); codeOf(err) != connect.CodePermissionDenied {
			t.Fatalf("LiftRestriction by %d: %v", who, err)
		}
	}
	// Nobody is an operator by default.
	plain := newHarnessOn(t, h.st, testTenant, nil)
	if plain.svc.IsOperator(m.operator) {
		t.Fatal("operator without configuration")
	}
	if _, err := plain.svc.GetReports(ctx, m.operator, &appv1.GetReportsRequest{}); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("unconfigured operator: %v", err)
	}
}

func TestModerationQueueListAndDetail(t *testing.T) {
	m := newModerationSetup(t)
	h, ctx := m.h, context.Background()
	open, err := h.svc.GetReports(ctx, m.operator, &appv1.GetReportsRequest{})
	if err != nil || len(open.GetReports()) != 2 {
		t.Fatalf("open reports = %v, %v", open, err)
	}
	// Newest first, one per page.
	first, err := h.svc.GetReports(ctx, m.operator, &appv1.GetReportsRequest{Limit: 1})
	if err != nil || len(first.GetReports()) != 1 || first.GetReports()[0].GetTargetKind() != appv1.ReportTargetKind_REPORT_TARGET_KIND_USER {
		t.Fatalf("first page = %v, %v", first, err)
	}
	second, err := h.svc.GetReports(ctx, m.operator, &appv1.GetReportsRequest{Limit: 1, Cursor: first.GetNextCursor()})
	if err != nil || len(second.GetReports()) != 1 || second.GetReports()[0].GetId() != m.reportID || second.GetNextCursor() != "" {
		t.Fatalf("second page = %v, %v", second, err)
	}
	if len(second.GetChats()) != 1 || second.GetChats()[0].GetId() != m.chatID {
		t.Fatalf("reported chat not attached: %v", second.GetChats())
	}
	byReason, err := h.svc.GetReports(ctx, m.operator, &appv1.GetReportsRequest{Reason: appv1.ReportReason_REPORT_REASON_SPAM})
	if err != nil || len(byReason.GetReports()) != 1 || byReason.GetReports()[0].GetTargetUserId() != m.spammer {
		t.Fatalf("by reason = %v, %v", byReason, err)
	}
	if none, err := h.svc.GetReports(ctx, m.operator, &appv1.GetReportsRequest{Status: appv1.ReportStatus_REPORT_STATUS_RESOLVED}); err != nil || len(none.GetReports()) != 0 {
		t.Fatalf("resolved before any = %v, %v", none, err)
	}
	if _, err := h.svc.GetReports(ctx, m.operator, &appv1.GetReportsRequest{Cursor: "x"}); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("bad cursor: %v", err)
	}

	// The reported message is deleted later; evidence keeps it, the context
	// shows it as it is now, with up to 5 messages on each side.
	if _, err := h.svc.DeleteMessages(ctx, m.spammer, m.chatID, []int64{m.spam}, true); err != nil {
		t.Fatal(err)
	}
	d, err := h.svc.GetReport(ctx, m.operator, m.reportID)
	if err != nil {
		t.Fatal(err)
	}
	if r := d.GetReport(); r.GetReason() != appv1.ReportReason_REPORT_REASON_SCAM || r.GetComment() != "fake prize" ||
		r.GetStatus() != appv1.ReportStatus_REPORT_STATUS_OPEN || !slices.Equal(r.GetSeqs(), []int64{m.spam}) {
		t.Fatalf("report = %v", r)
	}
	if ev := d.GetEvidence(); len(ev) != 1 || ev[0].GetText() != "win a phone at evil.example" || ev[0].GetFromId() != m.spammer {
		t.Fatalf("evidence = %v", ev)
	}
	var seqs []int64
	for _, msg := range d.GetContext() {
		seqs = append(seqs, msg.GetSeq())
		if msg.GetSeq() == m.spam && msg.GetText() != "" {
			t.Fatalf("deleted message shows content: %v", msg)
		}
	}
	if len(seqs) != 7 || seqs[5] != m.spam || seqs[0] != m.spam-5 || !slices.IsSorted(seqs) {
		t.Fatalf("context seqs = %v (spam %d)", seqs, m.spam)
	}
	if d.GetChat().GetId() != m.chatID {
		t.Fatalf("chat = %v", d.GetChat())
	}
	ids := map[int64]bool{}
	for _, u := range d.GetUsers() {
		ids[u.GetId()] = true
	}
	if !ids[m.reporter] || !ids[m.spammer] {
		t.Fatalf("users = %v", d.GetUsers())
	}
	if _, err := h.svc.GetReport(ctx, m.operator, m.reportID+1000); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("unknown report: %v", err)
	}
}

func TestModerationResolveWithActions(t *testing.T) {
	m := newModerationSetup(t)
	h, ctx := m.h, context.Background()
	if _, err := h.st.CreateSession(ctx, newSessionFor(m.spammer)); err != nil {
		t.Fatal(err)
	}
	other := h.group(m.spammer, m.reporter)
	resolve := func(actions []appv1.ModerationAction, note string, seconds int32) (*appv1.ResolveReportResponse, error) {
		return h.svc.ResolveReport(ctx, m.operator, &appv1.ResolveReportRequest{
			ReportId: m.reportID, Actions: actions, Note: note, RestrictSeconds: seconds,
		})
	}
	for name, bad := range map[string]func() error{
		"no action": func() error { _, err := resolve(nil, "x", 0); return err },
		"no note": func() error {
			_, err := resolve([]appv1.ModerationAction{appv1.ModerationAction_MODERATION_ACTION_DISMISS}, " ", 0)
			return err
		},
		"dismiss and act": func() error {
			_, err := resolve([]appv1.ModerationAction{appv1.ModerationAction_MODERATION_ACTION_DISMISS,
				appv1.ModerationAction_MODERATION_ACTION_DELETE_MESSAGES}, "x", 0)
			return err
		},
		"lift as action": func() error {
			_, err := resolve([]appv1.ModerationAction{appv1.ModerationAction_MODERATION_ACTION_LIFT_RESTRICTION}, "x", 0)
			return err
		},
		"too long": func() error {
			_, err := resolve([]appv1.ModerationAction{appv1.ModerationAction_MODERATION_ACTION_DISMISS}, strings.Repeat("x", moderationNoteMax+1), 0)
			return err
		},
		"negative restriction": func() error {
			_, err := resolve([]appv1.ModerationAction{appv1.ModerationAction_MODERATION_ACTION_RESTRICT_ACCOUNT}, "x", -1)
			return err
		},
	} {
		if err := bad(); codeOf(err) != connect.CodeInvalidArgument {
			t.Fatalf("%s: %v", name, err)
		}
	}
	h.drain()
	resp, err := resolve([]appv1.ModerationAction{
		appv1.ModerationAction_MODERATION_ACTION_RESTRICT_ACCOUNT,
		appv1.ModerationAction_MODERATION_ACTION_BAN_FROM_CHAT,
		appv1.ModerationAction_MODERATION_ACTION_DELETE_MESSAGES,
	}, "scam link", 3600)
	if err != nil {
		t.Fatal(err)
	}
	r := resp.GetReport()
	if r.GetStatus() != appv1.ReportStatus_REPORT_STATUS_RESOLVED || r.GetResolvedBy() != m.operator || r.GetResolvedAt() == 0 ||
		r.GetResolutionNote() != "scam link" || len(r.GetActions()) != 3 {
		t.Fatalf("resolved report = %v", r)
	}
	h.drain()
	// Members saw the message go and the spammer removed by moderation.
	var deleted, removed bool
	for _, u := range h.sink.updatesOf(m.reporter) {
		if d := u.GetMessageDelete(); d.GetChatId() == m.chatID && slices.Contains(d.GetSeqs(), m.spam) {
			deleted = true
		}
		if rm := u.GetMemberRemoved(); rm.GetChatId() == m.chatID && rm.GetUserId() == m.spammer && rm.GetActorId() == 0 {
			removed = true
		}
	}
	if !deleted || !removed {
		t.Fatalf("members saw delete %v, removal %v", deleted, removed)
	}
	if _, err := h.svc.JoinByInvite(ctx, m.spammer, mustLink(t, h, m.own, m.chatID)); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("banned spammer joins: %v", err)
	}
	// Sessions revoked, writes refused while restricted.
	var active int
	if err := h.st.Pool().QueryRow(ctx, `SELECT count(*) FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL`, m.spammer).Scan(&active); err != nil || active != 0 {
		t.Fatalf("active sessions = %d, %v", active, err)
	}
	if _, err := h.svc.SendMessage(ctx, m.spammer, &appv1.SendMessageRequest{ChatId: other, Text: "again"}); codeOf(err) != connect.CodePermissionDenied ||
		!strings.Contains(err.Error(), "account_restricted") {
		t.Fatalf("restricted send: %v", err)
	}
	if _, err := h.svc.CreateGroup(ctx, m.spammer, "g", nil, false); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("restricted create: %v", err)
	}
	if _, err := h.svc.ResolveReport(ctx, m.operator, &appv1.ResolveReportRequest{
		ReportId: m.reportID, Actions: []appv1.ModerationAction{appv1.ModerationAction_MODERATION_ACTION_DISMISS}, Note: "again",
	}); codeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("resolve twice: %v", err)
	}
	// The detail shows the log and the restriction.
	d, err := h.svc.GetReport(ctx, m.operator, m.reportID)
	if err != nil {
		t.Fatal(err)
	}
	if len(d.GetHistory()) != 2 || len(d.GetRestrictions()) != 1 || d.GetRestrictions()[0].GetUntil() == 0 {
		t.Fatalf("history %v restrictions %v", d.GetHistory(), d.GetRestrictions())
	}
	// The log is append-only.
	if _, err := h.st.Pool().Exec(ctx, `UPDATE moderation_log SET note = 'changed'`); err == nil {
		t.Fatal("moderation log was edited")
	}
	// Lifting restores writes.
	if err := h.svc.LiftRestriction(ctx, m.operator, m.spammer, ""); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("lift without note: %v", err)
	}
	if err := h.svc.LiftRestriction(ctx, m.operator, m.spammer, "appeal accepted"); err != nil {
		t.Fatal(err)
	}
	if err := h.svc.LiftRestriction(ctx, m.operator, m.spammer, "again"); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("lift twice: %v", err)
	}
	if _, err := h.svc.SendMessage(ctx, m.spammer, &appv1.SendMessageRequest{ChatId: other, Text: "sorry"}); err != nil {
		t.Fatalf("send after lift: %v", err)
	}
	// The user report is dismissed alone.
	user, err := h.svc.GetReports(ctx, m.operator, &appv1.GetReportsRequest{})
	if err != nil || len(user.GetReports()) != 1 {
		t.Fatalf("open after resolve = %v, %v", user, err)
	}
	dismissed, err := h.svc.ResolveReport(ctx, m.operator, &appv1.ResolveReportRequest{
		ReportId: user.GetReports()[0].GetId(), Actions: []appv1.ModerationAction{appv1.ModerationAction_MODERATION_ACTION_DISMISS}, Note: "duplicate",
	})
	if err != nil || dismissed.GetReport().GetStatus() != appv1.ReportStatus_REPORT_STATUS_DISMISSED {
		t.Fatalf("dismiss = %v, %v", dismissed, err)
	}
	if list, err := h.svc.GetReports(ctx, m.operator, &appv1.GetReportsRequest{Status: appv1.ReportStatus_REPORT_STATUS_DISMISSED}); err != nil || len(list.GetReports()) != 1 {
		t.Fatalf("dismissed list = %v, %v", list, err)
	}
}

func TestModerationRefusesBanningTheOwner(t *testing.T) {
	m := newModerationSetup(t)
	h, ctx := m.h, context.Background()
	seq := h.send(m.own, m.chatID, "owner post").GetMessage().GetSeq()
	if err := h.svc.Report(ctx, m.reporter, &appv1.ReportRequest{
		Target: &appv1.ReportRequest_Messages{Messages: &appv1.ReportedMessages{ChatId: m.chatID, Seqs: []int64{seq}}},
		Reason: appv1.ReportReason_REPORT_REASON_OTHER,
	}); err != nil {
		t.Fatal(err)
	}
	list, err := h.svc.GetReports(ctx, m.operator, &appv1.GetReportsRequest{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	id := list.GetReports()[0].GetId()
	_, err = h.svc.ResolveReport(ctx, m.operator, &appv1.ResolveReportRequest{
		ReportId: id, Actions: []appv1.ModerationAction{appv1.ModerationAction_MODERATION_ACTION_BAN_FROM_CHAT}, Note: "x",
	})
	if codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("ban the owner: %v", err)
	}
	// Nothing happened: the report is still open.
	d, err := h.svc.GetReport(ctx, m.operator, id)
	if err != nil || d.GetReport().GetStatus() != appv1.ReportStatus_REPORT_STATUS_OPEN {
		t.Fatalf("report after a refused action = %v, %v", d, err)
	}
}

func mustLink(t *testing.T, h *harness, owner, chatID int64) string {
	t.Helper()
	inv, err := h.svc.ExportInviteLink(context.Background(), owner, chatID, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	return inv.GetLink()
}
