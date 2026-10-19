package chat

import (
	"context"
	"strings"
	"time"

	appv1 "app.local/server/gen/app/v1"
)

// OpsSignals tells the tenant's operators at once that a user filed
// feedback or a report (package watch posts it into the "Vận hành chat"
// group). Called after the commit; a failure is logged, what was filed
// stands.
type OpsSignals interface {
	FeedbackFiled(ctx context.Context, f FeedbackSignal) error
	ReportFiled(ctx context.Context, r ReportSignal) error
}

// Filer is who filed feedback or a report, as the operators see them.
type Filer struct {
	ID             int64
	Name, Username string
}

// FeedbackSignal is one new feedback item.
type FeedbackSignal struct {
	ID         int64
	Kind, Text string
	// FromSettings: sent from Settings › Góp ý (else to the assistant).
	FromSettings bool
	From         Filer
}

// ReportSignal is one new report; it never carries the reported messages
// nor the reporter's comment.
type ReportSignal struct {
	ID     int64
	Reason appv1.ReportReason
	// Target is "user", "chat" or "messages"; Messages counts the latter.
	Target   string
	Messages int
	From     Filer
}

// signalTimeout bounds posting one signal; the caller's request may end
// meanwhile without cancelling it.
const signalTimeout = 10 * time.Second

// SetOpsSignals registers who tells the operators about new feedback and
// reports.
func (s *Service) SetOpsSignals(o OpsSignals) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.signals = o
}

func (s *Service) opsSignals() OpsSignals {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.signals
}

// filer loads who filed something; a failure leaves the name empty (the
// signal still goes out with the user id).
func (s *Service) filer(ctx context.Context, userID int64) Filer {
	f := Filer{ID: userID}
	users, err := loadUsers(ctx, s.pool, s.cfg.TenantID, []int64{userID})
	if err != nil {
		s.logger.Warn("ops signal: load the filer", "user_id", userID, "err", err)
		return f
	}
	if u := users[userID]; u != nil {
		f.Name, f.Username = u.Name, u.Username
	}
	return f
}

func (s *Service) signalFeedback(ctx context.Context, f FeedbackSignal) {
	o := s.opsSignals()
	if o == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), signalTimeout)
	defer cancel()
	f.From = s.filer(ctx, f.From.ID)
	if err := o.FeedbackFiled(ctx, f); err != nil {
		s.logger.Warn("ops signal of new feedback failed", "feedback_id", f.ID, "err", err)
	}
}

func (s *Service) signalReport(ctx context.Context, r ReportSignal) {
	o := s.opsSignals()
	if o == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), signalTimeout)
	defer cancel()
	r.From = s.filer(ctx, r.From.ID)
	if err := o.ReportFiled(ctx, r); err != nil {
		s.logger.Warn("ops signal of a new report failed", "report_id", r.ID, "err", err)
	}
}

// Excerpt is the first limit characters of text on one line, with "…" when
// cut.
func Excerpt(text string, limit int) string {
	text = strings.Join(strings.Fields(text), " ")
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return strings.TrimSpace(string(runes[:limit])) + "…"
}
