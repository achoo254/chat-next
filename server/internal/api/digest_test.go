package api_test

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/chat"
	"app.local/server/internal/watch"
	"connectrpc.com/connect"
)

// The daily digest counts the day before in Asia/Saigon, posts it once
// (also across a restart) and, after days down, posts only the latest
// missed day.
func TestDailyDigest(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	op := e.member(t, "digestop")
	a := e.member(t, "digesta")
	b := e.member(t, "digestb")
	group, notices := opsGroupOf(t, e, op)

	created, err := a.chats.CreatePrivate(ctx, connect.NewRequest(&appv1.CreatePrivateRequest{UserId: b.userID}))
	if err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{"chào", "mai họp nhé"} {
		if _, err := a.messages.SendMessage(ctx, connect.NewRequest(&appv1.SendMessageRequest{ChatId: created.Msg.GetChat().GetId(), Text: text})); err != nil {
			t.Fatal(err)
		}
	}
	if err := e.app.Chat.SendFeedback(ctx, b.userID, &appv1.SendFeedbackRequest{Text: "thêm chế độ tối"}); err != nil {
		t.Fatal(err)
	}
	if _, err := a.users.Report(ctx, connect.NewRequest(&appv1.ReportRequest{
		Target: &appv1.ReportRequest_UserId{UserId: b.userID}, Reason: appv1.ReportReason_REPORT_REASON_SPAM,
	})); err != nil {
		t.Fatal(err)
	}
	for i := range 4 {
		message := "TypeError: x is undefined"
		if i == 3 {
			message = "ChunkLoadError"
		}
		if err := e.app.Chat.RecordClientError(ctx, "digest-test", &appv1.ReportClientErrorRequest{
			Kind: appv1.ClientErrorKind_CLIENT_ERROR_KIND_ERROR, Message: message, Location: "assets/index.js:1:10",
		}); err != nil {
			t.Fatal(err)
		}
	}

	today := chat.SaigonDay(time.Now())
	at := func(days, hour int) time.Time {
		return time.Date(today.Year(), today.Month(), today.Day()+days, hour, 0, 0, 0, chat.Saigon)
	}
	now := at(1, 9)
	digest := func() *watch.Digest {
		return watch.NewDigest(watch.DigestConfig{TenantID: tenantID, Pool: e.store.Pool(), Group: group,
			Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Now: func() time.Time { return now }})
	}
	d := digest()
	if err := d.Once(ctx); err != nil {
		t.Fatal(err)
	}
	got := notices()
	if len(got) != 1 {
		t.Fatalf("notices = %q", got)
	}
	text := got[0]
	for _, want := range []string{
		"Bản tin ngày " + today.Format("02/01/2006"),
		"Người dùng mới: 3", "Người gửi tin: 1", "Tin nhắn: 2", "Góp ý mới: 1 (đang mở: 1)", "Báo cáo mới: 1",
		"Lỗi phía trình duyệt: 4", "1. [lỗi] TypeError: x is undefined (assets/index.js:1:10) ×3", "2. [lỗi] ChunkLoadError",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("digest %q lacks %q", text, want)
		}
	}
	// Once a day: again, and after a restart, nothing new.
	if err := d.Once(ctx); err != nil {
		t.Fatal(err)
	}
	if err := digest().Once(ctx); err != nil {
		t.Fatal(err)
	}
	if got := notices(); len(got) != 1 {
		t.Fatalf("digest posted again: %q", got)
	}
	// Down for days: before 08:00 the day before yesterday is due (already
	// past), from 08:00 only yesterday is posted.
	now = at(4, 7)
	if err := digest().Once(ctx); err != nil {
		t.Fatal(err)
	}
	if got := notices(); len(got) != 2 || !strings.Contains(got[1], "Bản tin ngày "+today.AddDate(0, 0, 2).Format("02/01/2006")) ||
		!strings.Contains(got[1], "Tin nhắn: 0") {
		t.Fatalf("missed day: %q", got)
	}
	now = at(4, 8)
	if err := digest().Once(ctx); err != nil {
		t.Fatal(err)
	}
	if got := notices(); len(got) != 3 || !strings.Contains(got[2], today.AddDate(0, 0, 3).Format("02/01/2006")) {
		t.Fatalf("next day: %q", got)
	}
}
