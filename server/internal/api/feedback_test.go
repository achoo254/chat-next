package api_test

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/chat"
	"app.local/server/internal/watch"
	"connectrpc.com/connect"
)

// opsGroupOf wires the operators' group of op and returns a reader of the
// notices posted into it.
func opsGroupOf(t *testing.T, e *env, op *chatClients) (*watch.Group, func() []string) {
	t.Helper()
	group := watch.NewGroup(watch.GroupConfig{
		TenantID: tenantID, Operators: []int64{op.userID}, Pool: e.store.Pool(), Chats: e.app.Chat, Hooks: e.app.Hooks,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	ctx := context.Background()
	notices := func() []string {
		t.Helper()
		dialogs, err := op.chats.GetDialogs(ctx, connect.NewRequest(&appv1.GetDialogsRequest{Limit: 50}))
		if err != nil {
			t.Fatal(err)
		}
		var chatID int64
		for _, c := range dialogs.Msg.GetChats() {
			if c.GetTitle() == watch.GroupTitle {
				chatID = c.GetId()
			}
		}
		if chatID == 0 {
			return nil
		}
		h, err := op.messages.GetHistory(ctx, connect.NewRequest(&appv1.GetHistoryRequest{ChatId: chatID, Limit: 50}))
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, m := range h.Msg.GetMessages() {
			if m.GetIntegrationLabel() != "" {
				out = append(out, m.GetText())
			}
		}
		return out
	}
	return group, notices
}

func feedbackClient(e *env, cl *chatClients) appv1connect.FeedbackServiceClient {
	return appv1connect.NewFeedbackServiceClient(cl.http, e.srv.URL+"/rpc", withOrigin(e.srv.URL))
}

// Feedback sent from Settings is stored like the assistant's (no message
// in its chat) and, like a new report, posted at once into the operators'
// group: a summary without contacts, never the reported content.
func TestFeedbackAndReportsReachOperators(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	op := e.member(t, "feedop")
	user := e.member(t, "feeduser")
	group, notices := opsGroupOf(t, e, op)
	e.app.Chat.SetOpsSignals(watch.NewSignals(group, e.srv.URL))
	fb := feedbackClient(e, user)

	if _, err := fb.SendFeedback(ctx, connect.NewRequest(&appv1.SendFeedbackRequest{Text: "   "})); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("empty feedback: %v", err)
	}
	if _, err := fb.SendFeedback(ctx, connect.NewRequest(&appv1.SendFeedbackRequest{Text: strings.Repeat("a", chat.FeedbackTextMax+1)})); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("long feedback: %v", err)
	}
	text := "Nút gửi ảnh không chạy. Gọi mình 0912 345 678 hoặc lan@mail.vn " + strings.Repeat("rất lâu ", 40)
	if _, err := fb.SendFeedback(ctx, connect.NewRequest(&appv1.SendFeedbackRequest{Kind: appv1.FeedbackKind_FEEDBACK_KIND_BUG, Text: text})); err != nil {
		t.Fatal(err)
	}
	var id, chatID, seq int64
	var kind, stored string
	if err := e.store.Pool().QueryRow(ctx, `SELECT id, chat_id, seq, kind, text FROM feedback WHERE user_id = $1`, user.userID).
		Scan(&id, &chatID, &seq, &kind, &stored); err != nil {
		t.Fatal(err)
	}
	if chatID != 0 || seq != -id || kind != chat.FeedbackBug || stored != strings.TrimSpace(text) {
		t.Fatalf("stored feedback = %d %d %d %q %q", id, chatID, seq, kind, stored)
	}
	got := notices()
	if len(got) != 1 {
		t.Fatalf("notices = %q", got)
	}
	n := got[0]
	for _, want := range []string{"Báo lỗi mới", "FEEDUSER (@feeduser)", "qua Cài đặt", "Nút gửi ảnh không chạy", "Kiểm duyệt › Góp ý", "…"} {
		if !strings.Contains(n, want) {
			t.Fatalf("notice %q lacks %q", n, want)
		}
	}
	for _, leak := range []string{"lan@mail.vn", "345 678", strings.Repeat("rất lâu ", 30)} {
		if strings.Contains(n, leak) {
			t.Fatalf("notice %q shows %q", n, leak)
		}
	}

	// A report: reason and target only.
	if _, err := user.users.Report(ctx, connect.NewRequest(&appv1.ReportRequest{
		Target: &appv1.ReportRequest_UserId{UserId: op.userID}, Reason: appv1.ReportReason_REPORT_REASON_SCAM, Comment: "bí mật riêng",
	})); err != nil {
		t.Fatal(err)
	}
	got = notices()
	if len(got) != 2 || !strings.Contains(got[1], "Báo cáo vi phạm mới") || !strings.Contains(got[1], "Lý do: Lừa đảo") ||
		!strings.Contains(got[1], "một người dùng") || strings.Contains(got[1], "bí mật riêng") {
		t.Fatalf("report notice = %q", got)
	}

	// Rate limited per user: a few in a row, then resource_exhausted.
	limited := false
	for range 6 {
		if _, err := fb.SendFeedback(ctx, connect.NewRequest(&appv1.SendFeedbackRequest{Text: "thêm ý"})); err != nil {
			if codeOf(err) != connect.CodeResourceExhausted {
				t.Fatal(err)
			}
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("feedback is not rate limited")
	}
}

// Without operators nothing is posted and the feedback still lands.
func TestFeedbackWithoutOperatorsGroup(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	user := e.member(t, "lonely")
	group := watch.NewGroup(watch.GroupConfig{TenantID: tenantID, Pool: e.store.Pool(), Chats: e.app.Chat, Hooks: e.app.Hooks,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	e.app.Chat.SetOpsSignals(watch.NewSignals(group, e.srv.URL))
	if _, err := feedbackClient(e, user).SendFeedback(ctx, connect.NewRequest(&appv1.SendFeedbackRequest{Text: "ý hay"})); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := e.store.Pool().QueryRow(ctx, `SELECT count(*) FROM feedback WHERE user_id = $1`, user.userID).Scan(&n); err != nil || n != 1 {
		t.Fatalf("feedback rows = %d, %v", n, err)
	}
	if err := e.store.Pool().QueryRow(ctx, `SELECT count(*) FROM ops_alert_hooks`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("ops hooks = %d, %v", n, err)
	}
}

// Client errors, also from a signed-out page: scrubbed, counted per kind
// and day, rate limited per caller.
func TestClientErrorReports(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	anon := appv1connect.NewFeedbackServiceClient(e.browser(t), e.srv.URL+"/rpc", withOrigin(e.srv.URL))
	report := func(c appv1connect.FeedbackServiceClient, req *appv1.ReportClientErrorRequest) {
		t.Helper()
		if _, err := c.ReportClientError(ctx, connect.NewRequest(req)); err != nil {
			t.Fatal(err)
		}
	}
	raw := "TypeError: lan@mail.vn opened https://chat.example/chat/123?token=abc and 0912345678 sk_abcdef0123456789abcdef \u0007"
	req := &appv1.ReportClientErrorRequest{
		Kind: appv1.ClientErrorKind_CLIENT_ERROR_KIND_ERROR, Message: raw,
		Location: "assets/index-Bx1.js:1:2345", Release: "index-Bx1", Route: "chat",
	}
	for range 3 {
		report(anon, req)
	}
	if _, err := anon.ReportClientError(ctx, connect.NewRequest(&appv1.ReportClientErrorRequest{Message: "x"})); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("no kind: %v", err)
	}
	// A bad location, release or route is dropped, not stored.
	report(anon, &appv1.ReportClientErrorRequest{Kind: appv1.ClientErrorKind_CLIENT_ERROR_KIND_RENDER, Message: "boom",
		Location: "https://evil.example/x.js?q=1:1", Release: "a b", Route: "chat/123"})

	type row struct {
		kind, message, location, release, route string
		count                                   int
	}
	rows := func() []row {
		t.Helper()
		r, err := e.store.Pool().Query(ctx, `SELECT kind, message, location, release, route, count FROM client_errors
			WHERE tenant_id = $1 AND day = $2 ORDER BY kind`, tenantID, chat.SaigonDay(time.Now()))
		if err != nil {
			t.Fatal(err)
		}
		defer r.Close()
		var out []row
		for r.Next() {
			var x row
			if err := r.Scan(&x.kind, &x.message, &x.location, &x.release, &x.route, &x.count); err != nil {
				t.Fatal(err)
			}
			out = append(out, x)
		}
		return out
	}
	got := rows()
	if len(got) != 2 {
		t.Fatalf("rows = %+v", got)
	}
	errRow, renderRow := got[0], got[1]
	if errRow.kind != "error" || errRow.count != 3 || errRow.location != "assets/index-Bx1.js:1:2345" || errRow.release != "index-Bx1" || errRow.route != "chat" {
		t.Fatalf("error row = %+v", errRow)
	}
	for _, leak := range []string{"lan@mail.vn", "token", "chat.example", "0912345678", "123", "abcdef0123456789", "\u0007"} {
		if strings.Contains(errRow.message, leak) {
			t.Fatalf("stored message %q keeps %q", errRow.message, leak)
		}
	}
	if !strings.HasPrefix(errRow.message, "TypeError:") {
		t.Fatalf("stored message %q", errRow.message)
	}
	if renderRow.location != "" || renderRow.release != "" || renderRow.route != "" {
		t.Fatalf("render row = %+v", renderRow)
	}

	// Past the caller's budget reports are dropped (same answer); a signed-in
	// user has a budget of their own.
	for range 20 {
		report(anon, req)
	}
	if c := rows()[0].count; c >= 23 || c < 3 {
		t.Fatalf("count after flood = %d", c)
	}
	before := rows()[0].count
	user := e.member(t, "crashy")
	report(feedbackClient(e, user), req)
	if c := rows()[0].count; c != before+1 {
		t.Fatalf("signed-in report counted %d, want %d", c, before+1)
	}
}
