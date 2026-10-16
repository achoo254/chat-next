package chat

import (
	"bytes"
	"context"
	"slices"
	"sync"
	"testing"

	appv1 "app.local/server/gen/app/v1"
)

// noticeRecorder is a Notifier that records what it was asked to say.
type noticeRecorder struct {
	mu      sync.Mutex
	notices map[int64][]ModerationNotice
}

func (r *noticeRecorder) NotifyModeration(_ context.Context, userID int64, n ModerationNotice) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.notices == nil {
		r.notices = map[int64][]ModerationNotice{}
	}
	r.notices[userID] = append(r.notices[userID], n)
	return nil
}

func TestReportGroupsAndClosingAGroup(t *testing.T) {
	m := newModerationSetup(t)
	h, ctx := m.h, context.Background()
	witness := h.user("witness")
	if _, err := h.svc.AddMembers(ctx, m.own, m.chatID, []int64{witness}); err != nil {
		t.Fatal(err)
	}
	if err := h.svc.Report(ctx, witness, &appv1.ReportRequest{
		Target: &appv1.ReportRequest_Messages{Messages: &appv1.ReportedMessages{ChatId: m.chatID, Seqs: []int64{m.spam}}},
		Reason: appv1.ReportReason_REPORT_REASON_SCAM, Comment: "phishing link",
	}); err != nil {
		t.Fatal(err)
	}

	groups, err := h.svc.GetReportGroups(ctx, m.operator, &appv1.GetReportGroupsRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if len(groups.GetGroups()) != 2 {
		t.Fatalf("groups = %v", groups.GetGroups())
	}
	top, next := groups.GetGroups()[0], groups.GetGroups()[1]
	if top.GetReportCount() != 2 || top.GetMainReason() != appv1.ReportReason_REPORT_REASON_SCAM ||
		top.GetReport().GetTargetKind() != appv1.ReportTargetKind_REPORT_TARGET_KIND_MESSAGES ||
		next.GetReportCount() != 1 || next.GetReport().GetTargetKind() != appv1.ReportTargetKind_REPORT_TARGET_KIND_USER {
		t.Fatalf("groups = %v", groups.GetGroups())
	}
	paged, err := h.svc.GetReportGroups(ctx, m.operator, &appv1.GetReportGroupsRequest{Limit: 1})
	if err != nil || len(paged.GetGroups()) != 1 || paged.GetNextCursor() == "" {
		t.Fatalf("first page = %v, %v", paged, err)
	}
	rest, err := h.svc.GetReportGroups(ctx, m.operator, &appv1.GetReportGroupsRequest{Limit: 1, Cursor: paged.GetNextCursor()})
	if err != nil || len(rest.GetGroups()) != 1 || rest.GetGroups()[0].GetReport().GetId() != next.GetReport().GetId() {
		t.Fatalf("second page = %v, %v", rest, err)
	}

	detail, err := h.svc.GetReport(ctx, m.operator, top.GetReport().GetId())
	if err != nil {
		t.Fatal(err)
	}
	g := detail.GetGroup()
	if g.GetReportCount() != 2 || g.GetReporterCount() != 2 || len(g.GetReasons()) != 1 || g.GetReasons()[0].GetCount() != 2 ||
		!slices.Equal(g.GetComments(), []string{"phishing link", "fake prize"}) {
		t.Fatalf("group summary = %v", g)
	}
	if len(detail.GetSignals()) != 1 {
		t.Fatalf("signals = %v", detail.GetSignals())
	}
	sig := detail.GetSignals()[0]
	if sig.GetUserId() != m.spammer || sig.GetChatsJoined_24H() != 1 || sig.GetOtherOpenReports() != 1 || sig.GetAccountAgeSeconds() > 3600 {
		t.Fatalf("spammer signals = %v", sig)
	}

	rec := &noticeRecorder{}
	h.svc.SetNotifier(rec)
	if _, err := h.svc.ResolveReport(ctx, m.operator, &appv1.ResolveReportRequest{
		ReportId: m.reportID, Note: "scam link",
		Actions: []appv1.ModerationAction{appv1.ModerationAction_MODERATION_ACTION_WARN, appv1.ModerationAction_MODERATION_ACTION_DELETE_MESSAGES},
	}); err != nil {
		t.Fatal(err)
	}
	open, err := h.svc.GetReportGroups(ctx, m.operator, &appv1.GetReportGroupsRequest{})
	if err != nil || len(open.GetGroups()) != 1 || open.GetGroups()[0].GetReport().GetTargetKind() != appv1.ReportTargetKind_REPORT_TARGET_KIND_USER {
		t.Fatalf("open groups after closing the message group = %v, %v", open, err)
	}
	closed, err := h.svc.GetReportGroups(ctx, m.operator, &appv1.GetReportGroupsRequest{Status: appv1.ReportStatus_REPORT_STATUS_RESOLVED})
	if err != nil || len(closed.GetGroups()) != 1 || closed.GetGroups()[0].GetReportCount() != 2 {
		t.Fatalf("resolved groups = %v, %v", closed, err)
	}
	got := rec.notices[m.spammer]
	if len(got) != 1 || got[0].Note != "scam link" || !slices.Contains(got[0].Actions, appv1.ModerationAction_MODERATION_ACTION_WARN) {
		t.Fatalf("notices = %v", rec.notices)
	}

	logResp, err := h.svc.GetModerationLog(ctx, m.operator, &appv1.GetModerationLogRequest{Action: appv1.ModerationAction_MODERATION_ACTION_WARN})
	if err != nil || len(logResp.GetEntries()) != 1 || logResp.GetEntries()[0].GetTargetUserId() != m.spammer {
		t.Fatalf("warn log = %v, %v", logResp, err)
	}
	all, err := h.svc.GetModerationLog(ctx, m.operator, &appv1.GetModerationLogRequest{Limit: 1})
	if err != nil || len(all.GetEntries()) != 1 || all.GetNextCursor() == "" {
		t.Fatalf("log page = %v, %v", all, err)
	}
	if _, err := h.svc.GetModerationLog(ctx, m.reporter, &appv1.GetModerationLogRequest{}); err == nil {
		t.Fatal("a non-operator read the moderation log")
	}
}

func TestDismissSendsNoNotice(t *testing.T) {
	m := newModerationSetup(t)
	h, ctx := m.h, context.Background()
	rec := &noticeRecorder{}
	h.svc.SetNotifier(rec)
	if _, err := h.svc.ResolveReport(ctx, m.operator, &appv1.ResolveReportRequest{
		ReportId: m.reportID, Note: "fine", Notify: true,
		Actions: []appv1.ModerationAction{appv1.ModerationAction_MODERATION_ACTION_DISMISS},
	}); err != nil {
		t.Fatal(err)
	}
	if len(rec.notices) != 0 {
		t.Fatalf("notices after dismiss = %v", rec.notices)
	}
}

func TestDisableWebhookFromAReport(t *testing.T) {
	m := newModerationSetup(t)
	h, ctx := m.h, context.Background()
	if _, err := h.st.Pool().Exec(ctx, `
		INSERT INTO incoming_hooks (id, tenant_id, chat_id, name, format, created_by, secret_hash, secret_created_by)
		VALUES ('hk_abcdefghijkl', $1, $2, 'CI Alerts', 'native', $3, $4, $3), ('hk_mnopqrstuvwx', $1, $2, 'CI Alerts', 'native', $3, $4, $3)`,
		testTenant, m.chatID, m.own, bytes.Repeat([]byte{1}, 32)); err != nil {
		t.Fatal(err)
	}
	var seq int64
	if err := h.svc.WithIntegration(ctx, m.chatID, nil, func(it *IntegrationTx) error {
		var err error
		seq, err = it.Post(ctx, IntegrationMessage{Label: "CI Alerts", Text: "build failed 3000 times", HookID: "hk_abcdefghijkl"})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := h.svc.Report(ctx, m.reporter, &appv1.ReportRequest{
		Target: &appv1.ReportRequest_Messages{Messages: &appv1.ReportedMessages{ChatId: m.chatID, Seqs: []int64{seq}}},
		Reason: appv1.ReportReason_REPORT_REASON_SPAM,
	}); err != nil {
		t.Fatal(err)
	}
	list, err := h.svc.GetReports(ctx, m.operator, &appv1.GetReportsRequest{TargetKind: appv1.ReportTargetKind_REPORT_TARGET_KIND_WEBHOOK})
	if err != nil || len(list.GetReports()) != 1 {
		t.Fatalf("webhook reports = %v, %v", list, err)
	}
	id := list.GetReports()[0].GetId()
	detail, err := h.svc.GetReport(ctx, m.operator, id)
	if err != nil || len(detail.GetHooks()) != 1 || detail.GetHooks()[0].GetName() != "CI Alerts" || detail.GetHooks()[0].GetDisabled() {
		t.Fatalf("reported hooks = %v, %v", detail.GetHooks(), err)
	}
	// Disabling a webhook needs a webhook report.
	if _, err := h.svc.ResolveReport(ctx, m.operator, &appv1.ResolveReportRequest{
		ReportId: m.reportID, Note: "x", Actions: []appv1.ModerationAction{appv1.ModerationAction_MODERATION_ACTION_DISABLE_WEBHOOK},
	}); err == nil {
		t.Fatal("disable_webhook accepted on a report about a person's message")
	}
	if _, err := h.svc.ResolveReport(ctx, m.operator, &appv1.ResolveReportRequest{
		ReportId: id, Note: "loop of 3000 messages an hour",
		Actions: []appv1.ModerationAction{appv1.ModerationAction_MODERATION_ACTION_DISABLE_WEBHOOK},
	}); err != nil {
		t.Fatal(err)
	}
	var state, reason string
	if err := h.st.Pool().QueryRow(ctx, `SELECT state, disabled_reason FROM incoming_hooks WHERE id = 'hk_abcdefghijkl'`).
		Scan(&state, &reason); err != nil || state != "disabled" || reason != "by_moderator" {
		t.Fatalf("hook = %s %s, %v", state, reason, err)
	}
	// The other hook with the same name keeps running.
	if err := h.st.Pool().QueryRow(ctx, `SELECT state FROM incoming_hooks WHERE id = 'hk_mnopqrstuvwx'`).Scan(&state); err != nil || state != "active" {
		t.Fatalf("namesake hook = %s, %v", state, err)
	}
	var audited int
	if err := h.st.Pool().QueryRow(ctx, `SELECT count(*) FROM hook_audit WHERE hook_id = 'hk_abcdefghijkl' AND detail = 'by_moderator' AND actor_id = 0`).
		Scan(&audited); err != nil || audited != 1 {
		t.Fatalf("hook audit = %d, %v", audited, err)
	}
	logResp, err := h.svc.GetModerationLog(ctx, m.operator, &appv1.GetModerationLogRequest{
		Action: appv1.ModerationAction_MODERATION_ACTION_DISABLE_WEBHOOK,
	})
	if err != nil || len(logResp.GetEntries()) != 1 || logResp.GetEntries()[0].GetHookId() != "hk_abcdefghijkl" {
		t.Fatalf("log = %v, %v", logResp, err)
	}
	var stopped bool
	if err := h.st.Pool().QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM messages WHERE chat_id = $1 AND seq > $2 AND from_id = 0)`,
		m.chatID, seq).Scan(&stopped); err != nil || !stopped {
		t.Fatalf("no service message about the stopped hook: %v", err)
	}
}

func TestBotAbuseRuleAndReview(t *testing.T) {
	m := newModerationSetup(t)
	h, ctx := m.h, context.Background()
	bot := h.bot(m.own, "promo_bot")
	// 50 users started the bot and talked with it today; 5 of them (10%)
	// blocked it.
	for i := range 50 {
		u := h.user("fan")
		if err := recordConsent(ctx, h.st.Pool(), bot, u, ConsentStart); err != nil {
			t.Fatal(err)
		}
		if _, _, err := h.svc.CreatePrivate(ctx, u, bot); err != nil {
			t.Fatal(err)
		}
		if i < 5 {
			if _, err := h.st.Pool().Exec(ctx, `INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)`, u, bot); err != nil {
				t.Fatal(err)
			}
		}
	}
	// 20 users, one of whom blocked it: 5%, but one person is not enough.
	quiet := h.bot(m.own, "quiet_bot")
	for i := range 20 {
		u := h.user("reader")
		if err := recordConsent(ctx, h.st.Pool(), quiet, u, ConsentStart); err != nil {
			t.Fatal(err)
		}
		if _, _, err := h.svc.CreatePrivate(ctx, u, quiet); err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			if _, err := h.st.Pool().Exec(ctx, `INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)`, u, quiet); err != nil {
				t.Fatal(err)
			}
		}
	}
	// A new bot that 60 people started on its first day is a launch, not a spike.
	launch := h.bot(m.own, "launch_bot")
	for range 60 {
		if err := recordConsent(ctx, h.st.Pool(), launch, h.user("early"), ConsentStart); err != nil {
			t.Fatal(err)
		}
	}
	if err := h.svc.ApplyBotAbuseRule(ctx); err != nil {
		t.Fatal(err)
	}
	reviews, err := h.svc.GetBotReviews(ctx, m.operator)
	if err != nil || len(reviews.GetReviews()) != 1 {
		t.Fatalf("reviews = %v, %v", reviews, err)
	}
	r := reviews.GetReviews()[0]
	if r.GetBotId() != bot || r.GetTier() != appv1.BotTier_BOT_TIER_RESTRICTED || !r.GetRestrictedAutomatically() ||
		r.GetBlockedPermille_24H() != 100 || r.GetUsers() != 50 || r.GetRestrictedReason() == "" {
		t.Fatalf("review = %v", r)
	}
	for _, id := range []int64{quiet, launch} {
		if q, err := h.svc.GetBotReview(ctx, m.operator, id); err != nil || q.GetReview().GetTier() != appv1.BotTier_BOT_TIER_NEW {
			t.Fatalf("bot %d = %v, %v", id, q, err)
		}
	}

	restored, err := h.svc.ReviewBotRestriction(ctx, m.operator, &appv1.ReviewBotRestrictionRequest{BotId: bot, Restore: true, Note: "launch day"})
	if err != nil || restored.GetTier() == appv1.BotTier_BOT_TIER_RESTRICTED || restored.GetRestrictedAt() != 0 {
		t.Fatalf("restored = %v, %v", restored, err)
	}
	// The rule leaves a restored bot alone for a day.
	if err := h.svc.ApplyBotAbuseRule(ctx); err != nil {
		t.Fatal(err)
	}
	if again, _ := h.svc.GetBotReview(ctx, m.operator, bot); again.GetReview().GetRestrictedAt() != 0 {
		t.Fatalf("restored bot restricted again: %v", again)
	}
	if _, err := h.svc.ReviewBotRestriction(ctx, m.operator, &appv1.ReviewBotRestrictionRequest{BotId: bot, Note: "x"}); codeOf(err) == 0 {
		t.Fatal("keeping a bot that is not restricted succeeded")
	}

	verified, err := h.svc.SetBotVerified(ctx, m.operator, &appv1.SetBotVerifiedRequest{BotId: quiet, Verified: true, Note: "ops bot"})
	if err != nil || !verified.GetVerified() || verified.GetTier() != appv1.BotTier_BOT_TIER_VERIFIED {
		t.Fatalf("verified = %v, %v", verified, err)
	}
	if _, err := h.svc.SetBotVerified(ctx, m.reporter, &appv1.SetBotVerifiedRequest{BotId: quiet, Note: "x"}); err == nil {
		t.Fatal("a non-operator changed verification")
	}
	logResp, err := h.svc.GetModerationLog(ctx, m.operator, &appv1.GetModerationLogRequest{AutomaticOnly: true})
	if err != nil || len(logResp.GetEntries()) != 1 || logResp.GetEntries()[0].GetAction() != appv1.ModerationAction_MODERATION_ACTION_RESTRICT_BOT {
		t.Fatalf("automatic log = %v, %v", logResp, err)
	}
}

func TestStrangerLimitIsLoggedOncePerDay(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.Abuse = AbuseLimits{StrangerChatsNew: 1, StrangerChats: 1} })
	ctx := context.Background()
	me := h.user("me")
	if _, _, err := h.svc.CreatePrivate(ctx, me, h.user("a")); err != nil {
		t.Fatal(err)
	}
	for range 3 {
		if _, _, err := h.svc.CreatePrivate(ctx, me, h.user("b")); err == nil {
			t.Fatal("over the limit")
		}
	}
	var n int
	if err := h.st.Pool().QueryRow(ctx, `SELECT count(*) FROM moderation_log WHERE target_user_id = $1 AND action = 'limit_stranger_chats'
		AND operator_id = 0`, me).Scan(&n); err != nil || n != 1 {
		t.Fatalf("log entries = %d, %v", n, err)
	}
}

func TestServiceMessagesAreNotWebhookReports(t *testing.T) {
	m := newModerationSetup(t)
	h, ctx := m.h, context.Background()
	// A service message from the server (from_id 0, no integration label).
	if err := h.svc.WithIntegration(ctx, m.chatID, nil, func(it *IntegrationTx) error {
		return it.HookStopped(ctx, 0, "Old hook", appv1.IncomingHookStopReason_INCOMING_HOOK_STOP_REASON_CREATOR_LEFT)
	}); err != nil {
		t.Fatal(err)
	}
	var seq int64
	if err := h.st.Pool().QueryRow(ctx, `SELECT max(seq) FROM messages WHERE chat_id = $1 AND from_id = 0`, m.chatID).Scan(&seq); err != nil {
		t.Fatal(err)
	}
	if err := h.svc.Report(ctx, m.reporter, &appv1.ReportRequest{
		Target: &appv1.ReportRequest_Messages{Messages: &appv1.ReportedMessages{ChatId: m.chatID, Seqs: []int64{seq}}},
		Reason: appv1.ReportReason_REPORT_REASON_SPAM,
	}); err != nil {
		t.Fatal(err)
	}
	hooks, err := h.svc.GetReports(ctx, m.operator, &appv1.GetReportsRequest{TargetKind: appv1.ReportTargetKind_REPORT_TARGET_KIND_WEBHOOK})
	if err != nil || len(hooks.GetReports()) != 0 {
		t.Fatalf("webhook reports = %v, %v", hooks, err)
	}
}
