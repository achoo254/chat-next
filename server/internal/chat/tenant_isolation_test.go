package chat

import (
	"context"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"connectrpc.com/connect"
)

// twoTenants is the primary tenant and a second one (inetdev.io.vn) on the
// same database, one Service each, as on the server: one process per tenant.
func twoTenants(t *testing.T) (primary, second *harness) {
	t.Helper()
	var operator int64
	h := newHarness(t, nil)
	operator = h.user("op")
	primary = newHarnessOn(t, h.st, testTenant, func(c *Config) { c.Operators = []int64{operator} })
	ctx := context.Background()
	if err := h.st.EnsureTenant(ctx, "inetdev", "inetdev.io.vn", "inetdev.io.vn"); err != nil {
		t.Fatal(err)
	}
	second = newHarnessOn(t, h.st, "inetdev", nil)
	return primary, second
}

// The tenant matrix: nothing of the primary tenant is reachable from a user
// of the second tenant, through any API that takes an id, a name or a query.
func TestNoAPIReachesAnotherTenant(t *testing.T) {
	primary, second := twoTenants(t)
	ctx := context.Background()
	lan, minh := primary.user("lan"), primary.user("minh")
	if _, err := primary.st.Pool().Exec(ctx, `UPDATE users SET email = 'lan@hoandat.com', email_verified = true WHERE id = $1`, lan); err != nil {
		t.Fatal(err)
	}
	if _, err := primary.st.Pool().Exec(ctx, `INSERT INTO privacy_settings (user_id, find_by_email) VALUES ($1, $2)
		ON CONFLICT (user_id) DO UPDATE SET find_by_email = excluded.find_by_email`, lan, audEveryone); err != nil {
		t.Fatal(err)
	}
	group := primary.group(lan, minh)
	seq := primary.send(lan, group, "bí mật của hoandat").GetMessage().GetSeq()
	bot := primary.bot(lan, "hoandat_bot")
	outsider := second.user("outsider")

	notFound := func(name string, err error) {
		t.Helper()
		if codeOf(err) != connect.CodeNotFound && codeOf(err) != connect.CodePermissionDenied {
			t.Errorf("%s across tenants: %v", name, err)
		}
	}
	_, err := second.svc.ResolveUsername(ctx, outsider, "lan")
	notFound("ResolveUsername", err)
	_, err = second.svc.AddContact(ctx, outsider, &appv1.AddContactRequest{Target: &appv1.AddContactRequest_Username{Username: "lan"}})
	notFound("AddContact by username", err)
	_, err = second.svc.AddContact(ctx, outsider, &appv1.AddContactRequest{Target: &appv1.AddContactRequest_Email{Email: "lan@hoandat.com"}})
	notFound("AddContact by email", err)
	_, err = second.svc.AddContact(ctx, outsider, &appv1.AddContactRequest{Target: &appv1.AddContactRequest_UserId{UserId: lan}})
	notFound("AddContact by id", err)
	if found, err := second.svc.SearchUsers(ctx, outsider, "lan@hoandat.com", 10); err != nil || len(found) != 0 {
		t.Errorf("SearchUsers by email across tenants = %v, %v", found, err)
	}
	_, err = second.svc.GetHistory(ctx, outsider, &appv1.GetHistoryRequest{ChatId: group, Limit: 10})
	notFound("GetHistory", err)
	_, err = second.svc.GetMembers(ctx, outsider, group, "", "", 10)
	notFound("GetMembers", err)
	_, _, err = second.svc.CreatePrivate(ctx, outsider, lan)
	notFound("CreatePrivate", err)
	_, err = second.svc.StartBot(ctx, outsider, &appv1.StartBotRequest{BotId: bot, RandomId: 77})
	notFound("StartBot", err)
	err = second.svc.Report(ctx, outsider, &appv1.ReportRequest{
		Target: &appv1.ReportRequest_Messages{Messages: &appv1.ReportedMessages{ChatId: group, Seqs: []int64{seq}}},
		Reason: appv1.ReportReason_REPORT_REASON_SPAM,
	})
	notFound("Report messages", err)
	err = second.svc.Report(ctx, outsider, &appv1.ReportRequest{Target: &appv1.ReportRequest_UserId{UserId: lan}, Reason: appv1.ReportReason_REPORT_REASON_SPAM})
	notFound("Report user", err)
	if found, err := second.svc.SearchMessages(ctx, outsider, &appv1.SearchMessagesRequest{Query: "bí mật"}); err != nil || len(found.GetMessages()) != 0 {
		t.Errorf("SearchMessages across tenants = %v, %v", found, err)
	}
	dialogs, err := second.svc.GetDialogs(ctx, outsider, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range dialogs.GetDialogs() {
		if d.GetChatId() == group {
			t.Error("the other tenant's group is in the dialog list")
		}
	}
}

// The moderation tools of one tenant see only its own reports, log and bots.
func TestModerationStaysInsideTheTenant(t *testing.T) {
	primary, second := twoTenants(t)
	ctx := context.Background()
	operator := primary.svc.cfg.Operators[0]
	lan, spammer := primary.user("lan"), primary.user("spammer")
	if err := primary.svc.Report(ctx, lan, &appv1.ReportRequest{
		Target: &appv1.ReportRequest_UserId{UserId: spammer}, Reason: appv1.ReportReason_REPORT_REASON_SPAM,
	}); err != nil {
		t.Fatal(err)
	}
	// An operator of the second tenant with the same id list sees nothing of the primary.
	op2 := second.user("op2")
	second2 := newHarnessOn(t, second.st, "inetdev", func(c *Config) { c.Operators = []int64{op2} })
	groups, err := second2.svc.GetReportGroups(ctx, op2, &appv1.GetReportGroupsRequest{})
	if err != nil || len(groups.GetGroups()) != 0 {
		t.Fatalf("report groups of the other tenant = %v, %v", groups, err)
	}
	mine, err := primary.svc.GetReportGroups(ctx, operator, &appv1.GetReportGroupsRequest{})
	if err != nil || len(mine.GetGroups()) != 1 {
		t.Fatalf("own report groups = %v, %v", mine, err)
	}
	if _, err := second2.svc.GetReport(ctx, op2, mine.GetGroups()[0].GetReport().GetId()); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("GetReport across tenants: %v", err)
	}
	bot := primary.bot(lan, "hoandat_bot")
	if _, err := second2.svc.GetBotReview(ctx, op2, bot); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("GetBotReview across tenants: %v", err)
	}
	if _, err := second2.svc.SetBotVerified(ctx, op2, &appv1.SetBotVerifiedRequest{BotId: bot, Verified: true, Note: "x"}); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("SetBotVerified across tenants: %v", err)
	}
	if _, err := primary.svc.SetBotVerified(ctx, operator, &appv1.SetBotVerifiedRequest{BotId: bot, Verified: true, Note: "ops"}); err != nil {
		t.Fatal(err)
	}
	logResp, err := second2.svc.GetModerationLog(ctx, op2, &appv1.GetModerationLogRequest{})
	if err != nil || len(logResp.GetEntries()) != 0 {
		t.Fatalf("moderation log of the other tenant = %v, %v", logResp, err)
	}
}

// Each tenant's process consumes its own outbox rows, with its own cursors.
func TestOutboxIsPerTenant(t *testing.T) {
	primary, second := twoTenants(t)
	ctx := context.Background()
	a, b := second.user("a"), second.user("b")
	chatID := second.group(a, b)
	second.send(a, chatID, "hello")
	x, y := primary.user("x"), primary.user("y")
	primaryChat := primary.group(x, y)
	mine, err := primary.svc.ReadOutbox(ctx, 0, 1000)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[int64]bool{}
	for _, row := range mine {
		seen[row.ChatID] = true
	}
	if seen[chatID] || !seen[primaryChat] {
		t.Fatalf("primary outbox chats = %v", seen)
	}
	theirs, err := second.svc.ReadOutbox(ctx, 0, 1000)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range theirs {
		if row.ChatID == primaryChat {
			t.Fatal("the second tenant reads the primary tenant's outbox")
		}
	}
	if primary.svc.CursorName("push") != "push" || second.svc.CursorName("push") != "push:inetdev" {
		t.Fatalf("cursor names = %s, %s", primary.svc.CursorName("push"), second.svc.CursorName("push"))
	}
}
