package botapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"app.local/server/internal/botadmin"
	"app.local/server/internal/botupdates"
	"app.local/server/internal/chat"
)

// setWebhookRequest is the body of PUT /webhook.
type setWebhookRequest struct {
	URL            string   `json:"url"`
	Secret         string   `json:"secret"`
	AllowedUpdates []string `json:"allowed_updates"`
	MaxConnections int      `json:"max_connections"`
	DropPending    bool     `json:"drop_pending"`
}

// webhookInfo is the result of GET /webhook.
type webhookInfo struct {
	URL              string   `json:"url"`
	PendingCount     int64    `json:"pending_update_count"`
	DeadLetterCount  int64    `json:"dead_letter_count"`
	MaxConnections   int      `json:"max_connections"`
	AllowedUpdates   []string `json:"allowed_updates"`
	LastError        string   `json:"last_error,omitempty"`
	LastErrorMessage string   `json:"last_error_message,omitempty"`
	LastErrorDate    int64    `json:"last_error_date,omitempty"`
	LastSuccessDate  int64    `json:"last_success_date,omitempty"`
	OpenConnections  int      `json:"open_connections"`
}

func (s *Service) setWebhook(ctx context.Context, r *http.Request, bot *botadmin.Bot) (any, error) {
	var req setWebhookRequest
	if err := decode(r, &req, false); err != nil {
		return nil, err
	}
	if req.URL == "" {
		return nil, errBadRequest("url is required (DELETE /webhook removes the webhook)")
	}
	if req.Secret == "" {
		return nil, errBadRequest("secret is required: 1 to 256 characters of A-Z, a-z, 0-9, _ and -")
	}
	err := s.updates.SetWebhook(ctx, bot.ID, botupdates.WebhookSettings{
		URL: req.URL, Secret: req.Secret, AllowedUpdates: req.AllowedUpdates, MaxConnections: req.MaxConnections,
		DropPending: req.DropPending,
	})
	if err != nil {
		return nil, webhookError(err)
	}
	return true, nil
}

func (s *Service) deleteWebhook(ctx context.Context, r *http.Request, bot *botadmin.Bot) (any, error) {
	drop := false
	if raw := r.URL.Query().Get("drop_pending"); raw != "" {
		v, err := strconv.ParseBool(raw)
		if err != nil {
			return nil, errBadRequest("drop_pending must be true or false")
		}
		drop = v
	}
	if err := s.updates.DeleteWebhook(ctx, bot.ID, drop); err != nil {
		return nil, webhookError(err)
	}
	return true, nil
}

func (s *Service) getWebhook(ctx context.Context, _ *http.Request, bot *botadmin.Bot) (any, error) {
	info, err := s.updates.WebhookInfo(ctx, bot.ID)
	if err != nil {
		return nil, webhookError(err)
	}
	out := webhookInfo{
		URL: info.URL, PendingCount: info.Pending, DeadLetterCount: info.DeadLetters, MaxConnections: info.MaxConnections,
		AllowedUpdates: info.AllowedUpdates, OpenConnections: info.OpenConnections,
	}
	if out.AllowedUpdates == nil {
		out.AllowedUpdates = []string{}
	}
	if info.LastError != "" {
		out.LastError, out.LastErrorMessage, out.LastErrorDate = info.LastError, FailureMessage(info.LastError), info.LastErrorAt.Unix()
	}
	if !info.LastDeliveredAt.IsZero() {
		out.LastSuccessDate = info.LastDeliveredAt.Unix()
	}
	return out, nil
}

func webhookError(err error) error {
	var we *botupdates.WebhookError
	switch {
	case errors.As(err, &we):
		return errBadRequest("%s", we.Description)
	case errors.Is(err, botupdates.ErrNoBot):
		return errNotFound("bot not found")
	default:
		return err
	}
}

// FailureMessage describes a delivery failure code (WebhookInfo.LastError).
func FailureMessage(code string) string {
	if status, ok := strings.CutPrefix(code, "http_"); ok {
		n, _ := strconv.Atoi(status)
		return "the webhook answered HTTP " + status + " " + http.StatusText(n)
	}
	switch code {
	case "timeout":
		return "no answer within 10 seconds"
	case "tls":
		return "TLS failed (certificate not valid for the host, expired or not trusted)"
	case "connect":
		return "could not connect"
	case "dns":
		return "the host name does not resolve"
	case "blocked_address":
		return "the host resolves to a private, local or reserved address"
	case "invalid_url":
		return "the url is not allowed"
	case "secret_unreadable":
		return "the stored secret cannot be read; set the webhook again"
	default:
		return code
	}
}

// replyTimeout bounds a webhook answer's action.
const replyTimeout = 10 * time.Second

// webhookAnswerCallback is answerCallback in a webhook answer.
type webhookAnswerCallback struct {
	CallbackID string `json:"callback_id"`
	Text       string `json:"text"`
	ShowAlert  bool   `json:"show_alert"`
	URL        string `json:"url"`
}

// WebhookReply runs the method a bot's webhook answered with (a JSON
// object with "method" and that method's fields), as the bot, with the
// same checks and rate limits as the HTTP call. Supported: sendMessage
// (its random_id is always randomID, derived from the update, so a
// redelivered update never sends twice) and answerCallback (answering
// twice is not an error here). A body without "method" is no action.
func (s *Service) WebhookReply(ctx context.Context, botID, randomID int64, body []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		return nil
	}
	rawMethod, ok := fields["method"]
	if !ok {
		return nil
	}
	var method string
	if err := json.Unmarshal(rawMethod, &method); err != nil {
		return errors.New("method must be a string")
	}
	delete(fields, "method")
	rest, err := json.Marshal(fields)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(chat.AsBot(ctx, botID), replyTimeout)
	defer cancel()
	bot, err := s.admin.Live(ctx, botID)
	if err != nil {
		return err
	}
	if !bot.Webhook {
		return errors.New("the bot has no webhook any more")
	}
	rules := tiers[bot.Tier()]
	if !s.limiter.Allow(rules.calls, fmt.Sprintf("botcall:%d", bot.ID)) {
		return errRateLimited(rules.calls)
	}
	switch method {
	case "sendMessage":
		var req sendMessageRequest
		if err := strictJSON(rest, &req); err != nil {
			return err
		}
		req.RandomID = randomID
		_, err := s.send(ctx, bot, req)
		return err
	case "answerCallback":
		var req webhookAnswerCallback
		if err := strictJSON(rest, &req); err != nil {
			return err
		}
		if req.CallbackID == "" {
			return errBadRequest("callback_id is required")
		}
		err := s.updates.Answer(ctx, bot.ID, req.CallbackID, botupdates.Answer{Text: req.Text, ShowAlert: req.ShowAlert, URL: req.URL})
		if errors.Is(err, botupdates.ErrAnswered) {
			return nil
		}
		return err
	default:
		return errBadRequest("method %q cannot be used in a webhook answer (use sendMessage or answerCallback)", method)
	}
}

func strictJSON(body []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return errBadRequest("invalid JSON body: %s", jsonProblem(err))
	}
	return nil
}
