package watch

import (
	"strings"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/chat"
)

func TestDueDay(t *testing.T) {
	at := func(day, hour int) time.Time { return time.Date(2026, 10, day, hour, 30, 0, 0, chat.Saigon) }
	for _, c := range []struct {
		now  time.Time
		want string
	}{
		{at(19, 7), "2026-10-17"},
		{at(19, 8), "2026-10-18"},
		{at(19, 23), "2026-10-18"},
		// 00:30 in Saigon is still the previous day in UTC.
		{at(20, 0).UTC(), "2026-10-18"},
	} {
		if got := DueDay(c.now).Format(time.DateOnly); got != c.want {
			t.Errorf("DueDay(%v) = %s, want %s", c.now, got, c.want)
		}
	}
}

// Bold entities cover their words in UTF-16 units, Vietnamese included.
func TestNoticeEntities(t *testing.T) {
	n := (&Notice{}).Bold("Góp ý mới").Write(" từ ").Bold("Lan 😀")
	text := n.Text()
	units := utf16Len(text)
	if len(n.entities) != 2 || n.entities[0].Offset != 0 || n.entities[0].Length != utf16Len("Góp ý mới") ||
		n.entities[1].Offset != utf16Len("Góp ý mới từ ") || n.entities[1].Offset+n.entities[1].Length != units {
		t.Fatalf("entities %+v of %q", n.entities, text)
	}
}

func TestFeedbackNoticeScrubsContacts(t *testing.T) {
	s := NewSignals(nil, "https://chat.example")
	n := s.FeedbackNotice(chat.FeedbackSignal{ID: 7, Kind: chat.FeedbackIdea, Text: "Gọi +84 912 345 678, mail lan@mail.vn " + strings.Repeat("x", 300),
		From: chat.Filer{ID: 3, Name: "Lan"}})
	text := n.Text()
	if strings.Contains(text, "912") || strings.Contains(text, "lan@mail.vn") || !strings.Contains(text, "Góp ý mới từ Lan (qua bot Trợ lý)") {
		t.Fatalf("notice %q", text)
	}
	if n.Key != "feedback:7" || len(n.buttons) != 1 || n.buttons[0].URL != "https://chat.example/moderation/feedback" {
		t.Fatalf("notice %+v", n)
	}
	r := s.ReportNotice(chat.ReportSignal{ID: 2, Reason: appv1.ReportReason_REPORT_REASON_SPAM, Target: "messages", Messages: 3, From: chat.Filer{ID: 9}})
	if !strings.Contains(r.Text(), "Người dùng 9") || !strings.Contains(r.Text(), "3 tin nhắn") {
		t.Fatalf("report notice %q", r.Text())
	}
}
