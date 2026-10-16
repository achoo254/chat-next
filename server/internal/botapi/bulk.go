package botapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"app.local/server/internal/botadmin"
	"app.local/server/internal/botapi/wire"
	"app.local/server/internal/botbulk"
	"app.local/server/internal/chat"
)

// bulkRules are the bulk send limits of a tier: messages per second of one
// job, and recipients in 24 hours.
type bulkRules struct {
	pace, daily int
}

var bulkTiers = map[string]bulkRules{
	botadmin.TierNew:        {pace: 2, daily: 1000},
	botadmin.TierDefault:    {pace: 10, daily: 10000},
	botadmin.TierVerified:   {pace: 50, daily: 1000000},
	botadmin.TierInternal:   {pace: 200, daily: botbulk.Unlimited},
	botadmin.TierRestricted: {pace: 1, daily: 0},
}

// UseBulk connects bulk sends; call it before serving. Without it
// messages:bulk answers 503.
func (s *Service) UseBulk(b *botbulk.Service) { s.bulk = b }

type bulkRequest struct {
	UserIDs            []int64           `json:"user_ids"`
	All                bool              `json:"all"`
	Text               string            `json:"text"`
	Entities           []wire.Entity     `json:"entities"`
	ParseMode          string            `json:"parse_mode"`
	ReplyMarkup        *wire.ReplyMarkup `json:"reply_markup"`
	DisableLinkPreview bool              `json:"disable_link_preview"`
}

type bulkJob struct {
	BulkID     int64  `json:"bulk_id"`
	State      string `json:"state"`
	Reason     string `json:"reason,omitempty"`
	Total      int    `json:"total"`
	Sent       int    `json:"sent"`
	Skipped    int    `json:"skipped"`
	Failed     int    `json:"failed"`
	CreatedAt  int64  `json:"created_at"`
	FinishedAt int64  `json:"finished_at,omitempty"`
}

func renderJob(j *botbulk.Job) bulkJob {
	out := bulkJob{BulkID: j.ID, State: j.State, Reason: j.Reason, Total: j.Total, Sent: j.Sent, Skipped: j.Skipped,
		Failed: j.Failed, CreatedAt: j.CreatedAt.Unix()}
	if j.FinishedAt != nil {
		out.FinishedAt = j.FinishedAt.Unix()
	}
	return out
}

// sendBulk queues one message to many users who started the bot.
func (s *Service) sendBulk(ctx context.Context, r *http.Request, bot *botadmin.Bot) (any, error) {
	if s.bulk == nil {
		return nil, &apiError{status: http.StatusServiceUnavailable, code: "unavailable", description: "bulk sends are not enabled"}
	}
	var req bulkRequest
	if err := decode(r, &req, false); err != nil {
		return nil, err
	}
	switch {
	case req.All && len(req.UserIDs) > 0:
		return nil, errBadRequest("give user_ids or all, not both")
	case !req.All && len(req.UserIDs) == 0:
		return nil, errBadRequest("user_ids or all is required")
	case len(req.UserIDs) > botbulk.MaxRecipients:
		return nil, errBadRequest("at most %d user_ids", botbulk.MaxRecipients)
	}
	for _, id := range req.UserIDs {
		if err := checkID("user_ids", id); err != nil {
			return nil, err
		}
	}
	text, ents, err := s.parseText(req.Text, req.Entities, req.ParseMode)
	if err != nil {
		return nil, err
	}
	markup, err := wire.ToMarkup(req.ReplyMarkup)
	if err != nil {
		return nil, errBadRequest("%v", err)
	}
	rules := bulkTiers[bot.Tier()]
	job, err := s.bulk.Create(ctx, botbulk.Request{
		BotID: bot.ID, UserIDs: req.UserIDs, All: req.All, Pace: rules.pace, Cap: rules.daily,
		Message: chat.BotMessage{Text: text, Entities: ents, Markup: markup, NoLinkPreview: req.DisableLinkPreview},
	})
	var quota *botbulk.QuotaError
	switch {
	case errors.As(err, &quota):
		return nil, &apiError{status: http.StatusTooManyRequests, code: "bulk_quota",
			description: fmt.Sprintf("the bot may reach %d users a day in bulk; %d left", quota.Cap, quota.Left),
			retryAfter:  int(time.Hour.Seconds())}
	case errors.Is(err, botbulk.ErrTooManyActive):
		return nil, &apiError{status: http.StatusTooManyRequests, code: "bulk_busy",
			description: fmt.Sprintf("at most %d unfinished bulk sends", botbulk.MaxActive), retryAfter: 60}
	case errors.Is(err, botbulk.ErrNoRecipients):
		return nil, errBadRequest("no user has started the bot")
	case err != nil:
		return nil, err
	}
	return renderJob(job), nil
}

func (s *Service) bulkID(r *http.Request) (int64, error) {
	if s.bulk == nil {
		return 0, &apiError{status: http.StatusServiceUnavailable, code: "unavailable", description: "bulk sends are not enabled"}
	}
	id, action, err := pathID(r.PathValue("bulk_id"), "bulk_id")
	if err != nil {
		return 0, err
	}
	if action != "" {
		return 0, errNotFound("unknown method")
	}
	return id, nil
}

// getBulk answers a bulk send's progress.
func (s *Service) getBulk(ctx context.Context, r *http.Request, bot *botadmin.Bot) (any, error) {
	id, err := s.bulkID(r)
	if err != nil {
		return nil, err
	}
	job, err := s.bulk.Get(ctx, bot.ID, id)
	if errors.Is(err, botbulk.ErrNoJob) {
		return nil, errNotFound("bulk send not found")
	}
	if err != nil {
		return nil, err
	}
	return renderJob(job), nil
}

// cancelBulk stops a bulk send; messages already sent stay.
func (s *Service) cancelBulk(ctx context.Context, r *http.Request, bot *botadmin.Bot) (any, error) {
	id, err := s.bulkID(r)
	if err != nil {
		return nil, err
	}
	job, err := s.bulk.Cancel(ctx, bot.ID, id)
	if errors.Is(err, botbulk.ErrNoJob) {
		return nil, errNotFound("bulk send not found")
	}
	if err != nil {
		return nil, err
	}
	return renderJob(job), nil
}
