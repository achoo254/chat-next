package assistant

import (
	"context"
	"errors"
	"fmt"
	"slices"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/botapi"
	"app.local/server/internal/botbulk"
	"app.local/server/internal/chat"
	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
)

// Announcements: the operators tell every user who started the assistant
// about new features. Each is a bulk send of the assistant ("all" its
// users) at the internal tier's pace; the caller checks the operator.

// announcementsShown bounds GetAnnouncements.
const announcementsShown = 50

var errNoBulk = connect.NewError(connect.CodeUnavailable, errors.New("announcements are not enabled"))

// UseBulk connects announcements; call it before serving.
func (s *Service) UseBulk(b *botbulk.Service) { s.bulk = b }

// parseAnnouncement parses text (Bot API markdown) and checks it as the
// assistant's message.
func (s *Service) parseAnnouncement(ctx context.Context, text string) (string, []*appv1.MessageEntity, error) {
	parsed, ents, err := s.api.ParseMarkdown(text)
	if err != nil {
		return "", nil, err
	}
	return s.chat.CheckBotMessage(ctx, s.botID, chat.BotMessage{Text: parsed, Entities: ents})
}

// PreviewAnnouncement is text as users would get it, and their number.
func (s *Service) PreviewAnnouncement(ctx context.Context, text string) (*appv1.PreviewAnnouncementResponse, error) {
	if s.bulk == nil {
		return nil, errNoBulk
	}
	parsed, ents, err := s.parseAnnouncement(ctx, text)
	if err != nil {
		return nil, err
	}
	n, err := s.bulk.Audience(ctx, s.botID)
	if err != nil {
		return nil, err
	}
	return &appv1.PreviewAnnouncementResponse{Text: parsed, Entities: ents, Audience: int32(n)}, nil
}

// SendAnnouncement queues text for every user who started the assistant.
func (s *Service) SendAnnouncement(ctx context.Context, operator int64, text string) (*appv1.Announcement, error) {
	if s.bulk == nil {
		return nil, errNoBulk
	}
	parsed, ents, err := s.parseAnnouncement(ctx, text)
	if err != nil {
		return nil, err
	}
	pace, daily := botapi.InternalBulk()
	job, err := s.bulk.Create(ctx, botbulk.Request{
		BotID: s.botID, All: true, Pace: pace, Cap: daily, CreatedBy: operator,
		Message: chat.BotMessage{Text: parsed, Entities: ents},
	})
	switch {
	case errors.Is(err, botbulk.ErrNoRecipients):
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("no_recipients: nobody has started the assistant"))
	case errors.Is(err, botbulk.ErrTooManyActive):
		return nil, connect.NewError(connect.CodeFailedPrecondition,
			fmt.Errorf("busy: at most %d announcements are sent at once", botbulk.MaxActive))
	case err != nil:
		return nil, err
	}
	s.logger.Info("announcement queued", "job_id", job.ID, "operator_id", operator, "recipients", job.Total)
	return renderAnnouncement(job)
}

// Announcements are the newest announcements, the operators who sent
// them, and the users who started the assistant now.
func (s *Service) Announcements(ctx context.Context) ([]*appv1.Announcement, []int64, int, error) {
	if s.bulk == nil {
		return nil, nil, 0, errNoBulk
	}
	jobs, err := s.bulk.List(ctx, s.botID, announcementsShown)
	if err != nil {
		return nil, nil, 0, err
	}
	out := make([]*appv1.Announcement, 0, len(jobs))
	var operators []int64
	for _, j := range jobs {
		a, err := renderAnnouncement(j)
		if err != nil {
			return nil, nil, 0, err
		}
		out = append(out, a)
		if j.CreatedBy != 0 && !slices.Contains(operators, j.CreatedBy) {
			operators = append(operators, j.CreatedBy)
		}
	}
	n, err := s.bulk.Audience(ctx, s.botID)
	if err != nil {
		return nil, nil, 0, err
	}
	return out, operators, n, nil
}

// CancelAnnouncement stops an announcement being sent.
func (s *Service) CancelAnnouncement(ctx context.Context, operator, id int64) (*appv1.Announcement, error) {
	if s.bulk == nil {
		return nil, errNoBulk
	}
	job, err := s.bulk.Cancel(ctx, s.botID, id)
	if errors.Is(err, botbulk.ErrNoJob) {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("announcement not found"))
	}
	if err != nil {
		return nil, err
	}
	s.logger.Info("announcement cancelled", "job_id", id, "operator_id", operator)
	return renderAnnouncement(job)
}

var announcementStates = map[string]appv1.AnnouncementState{
	botbulk.StateQueued:    appv1.AnnouncementState_ANNOUNCEMENT_STATE_QUEUED,
	botbulk.StateRunning:   appv1.AnnouncementState_ANNOUNCEMENT_STATE_RUNNING,
	botbulk.StateDone:      appv1.AnnouncementState_ANNOUNCEMENT_STATE_DONE,
	botbulk.StateCancelled: appv1.AnnouncementState_ANNOUNCEMENT_STATE_CANCELLED,
}

func renderAnnouncement(j *botbulk.Job) (*appv1.Announcement, error) {
	a := &appv1.Announcement{
		Id: j.ID, Text: j.Text, State: announcementStates[j.State], Reason: j.Reason, Total: int32(j.Total),
		Sent: int32(j.Sent), Skipped: int32(j.Skipped), Failed: int32(j.Failed), CreatedAt: j.CreatedAt.Unix(), CreatedBy: j.CreatedBy,
	}
	if j.FinishedAt != nil {
		a.FinishedAt = j.FinishedAt.Unix()
	}
	if len(j.Content) > 0 {
		var c appv1.Message
		if err := proto.Unmarshal(j.Content, &c); err != nil {
			return nil, fmt.Errorf("assistant: decode announcement: %w", err)
		}
		a.Entities = c.GetEntities()
	}
	return a, nil
}
