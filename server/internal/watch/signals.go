package watch

import (
	"context"
	"fmt"
	"strconv"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/chat"
)

// ExcerptMax bounds the part of a feedback item quoted in its notice.
const ExcerptMax = 140

// Signals posts a notice into the operators' group for each new feedback
// item and report (chat.OpsSignals): what kind, who sent it, and where to
// handle it. A report notice never quotes the reported messages nor the
// reporter's comment; no notice carries an email address or phone number.
type Signals struct {
	group *Group
	// origin is the app's public origin for the links ("" for none).
	origin string
}

// NewSignals returns the notices of new feedback and reports.
func NewSignals(group *Group, publicOrigin string) *Signals {
	return &Signals{group: group, origin: publicOrigin}
}

var feedbackKindNames = map[string]string{chat.FeedbackIdea: "Góp ý", chat.FeedbackBug: "Báo lỗi"}

var reportReasonNames = map[appv1.ReportReason]string{
	appv1.ReportReason_REPORT_REASON_SPAM:          "Spam",
	appv1.ReportReason_REPORT_REASON_SCAM:          "Lừa đảo",
	appv1.ReportReason_REPORT_REASON_VIOLENCE:      "Bạo lực",
	appv1.ReportReason_REPORT_REASON_SEXUAL:        "Nội dung khiêu dâm",
	appv1.ReportReason_REPORT_REASON_CHILD_ABUSE:   "Xâm hại trẻ em",
	appv1.ReportReason_REPORT_REASON_ILLEGAL:       "Vi phạm pháp luật",
	appv1.ReportReason_REPORT_REASON_PERSONAL_DATA: "Lộ thông tin cá nhân",
	appv1.ReportReason_REPORT_REASON_OTHER:         "Khác",
}

// filerName is "Name (@username)", the name alone, or the user id.
func filerName(f chat.Filer) string {
	name := f.Name
	if name == "" {
		name = "Người dùng " + strconv.FormatInt(f.ID, 10)
	}
	if f.Username != "" {
		name += " (@" + f.Username + ")"
	}
	return name
}

func (s *Signals) link(path string) string {
	if s.origin == "" {
		return ""
	}
	return s.origin + path
}

// FeedbackNotice is the notice of one new feedback item.
func (s *Signals) FeedbackNotice(f chat.FeedbackSignal) *Notice {
	kind := feedbackKindNames[f.Kind]
	if kind == "" {
		kind = "Góp ý"
	}
	source := "bot Trợ lý"
	if f.FromSettings {
		source = "Cài đặt"
	}
	n := &Notice{Key: "feedback:" + strconv.FormatInt(f.ID, 10)}
	n.Bold(kind + " mới").Write(" từ ").Bold(filerName(f.From)).Write(" (qua " + source + ")\n")
	n.Write("«" + chat.Excerpt(chat.ScrubContacts(f.Text), ExcerptMax) + "»\n")
	n.Write("Xem và trả lời: Kiểm duyệt › Góp ý")
	n.Button("Mở Góp ý", s.link("/moderation/feedback"))
	return n
}

// ReportNotice is the notice of one new report.
func (s *Signals) ReportNotice(r chat.ReportSignal) *Notice {
	target := "một người dùng"
	switch r.Target {
	case "chat":
		target = "một cuộc trò chuyện"
	case "messages":
		target = fmt.Sprintf("%d tin nhắn", r.Messages)
	}
	reason := reportReasonNames[r.Reason]
	if reason == "" {
		reason = "Khác"
	}
	n := &Notice{Key: "report:" + strconv.FormatInt(r.ID, 10)}
	n.Bold("Báo cáo vi phạm mới").Write(" từ ").Bold(filerName(r.From)).Write("\n")
	n.Write("Lý do: " + reason + " · Đối tượng: " + target + "\n")
	n.Write("Xử lý: Kiểm duyệt › Báo cáo")
	n.Button("Mở Kiểm duyệt", s.link("/moderation"))
	return n
}

// FeedbackFiled posts the notice of a new feedback item.
func (s *Signals) FeedbackFiled(ctx context.Context, f chat.FeedbackSignal) error {
	return s.group.Post(ctx, "feedback", s.FeedbackNotice(f))
}

// ReportFiled posts the notice of a new report.
func (s *Signals) ReportFiled(ctx context.Context, r chat.ReportSignal) error {
	return s.group.Post(ctx, "report", s.ReportNotice(r))
}
