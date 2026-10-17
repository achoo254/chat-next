package chatbot

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"
)

const (
	defaultPollTimeout = 50
	pollBackoffFirst   = time.Second
	pollBackoffCap     = 30 * time.Second
)

// PollOptions tunes Poll; the zero value (or nil) uses the defaults.
type PollOptions struct {
	// Timeout is the long-poll wait in seconds (default 50).
	Timeout int64
	// Limit caps the updates per request (server default when 0).
	Limit int64
	// AllowedUpdates is the comma-separated kinds to receive; empty keeps the
	// bot's current setting.
	AllowedUpdates string
}

// Poll receives updates with getUpdates until ctx ends and runs handle for
// each one, in order. Every update is acknowledged (the next offset is its
// update_id + 1) whether handle succeeds or not; handler errors and panics are
// logged. A returned WebhookAnswer is run through the API.
//
// Network errors, 5xx and 429 wait (1 s doubling up to 30 s, or retry_after)
// and poll again. 409 conflict (another poll runs, or a webhook is set) and
// other 4xx errors stop the loop and are returned. Poll returns nil when ctx
// ends.
func Poll(ctx context.Context, c *Client, handle HandlerFunc, opts *PollOptions) error {
	params := GetUpdatesParams{Timeout: defaultPollTimeout}
	if opts != nil {
		if opts.Timeout > 0 {
			params.Timeout = opts.Timeout
		}
		params.Limit = opts.Limit
		params.AllowedUpdates = opts.AllowedUpdates
	}
	backoff := pollBackoffFirst
	for {
		updates, err := c.GetUpdates(ctx, params)
		if ctx.Err() != nil {
			return nil
		}
		if err != nil {
			wait, fatal := pollFailure(err, backoff)
			if fatal {
				return err
			}
			slog.WarnContext(ctx, "chatbot: getUpdates failed, retrying", "wait", wait, "error", err)
			if c.sleep(ctx, wait) != nil {
				return nil
			}
			backoff = min(backoff*2, pollBackoffCap)
			continue
		}
		backoff = pollBackoffFirst
		for _, u := range updates {
			params.Offset = u.UpdateID + 1
			answer, err := safeHandle(ctx, handle, u)
			if err != nil {
				slog.ErrorContext(ctx, "chatbot: update handler failed", "update_id", u.UpdateID, "error", err)
			} else if answer != nil {
				if err := runAnswer(ctx, c, answer); err != nil {
					slog.ErrorContext(ctx, "chatbot: run handler answer", "update_id", u.UpdateID, "error", err)
				}
			}
			if ctx.Err() != nil {
				acknowledge(c, params.Offset)
				return nil
			}
		}
	}
}

// acknowledge confirms the updates handled before a stop (getUpdates with the
// next offset and no wait), so a restarted bot does not get them again.
func acknowledge(c *Client, offset int64) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := c.GetUpdates(ctx, GetUpdatesParams{Offset: offset, Limit: 1}); err != nil {
		slog.Warn("chatbot: acknowledge handled updates", "offset", offset, "error", err)
	}
}

// pollFailure classifies a getUpdates error: how long to wait, or fatal.
func pollFailure(err error, backoff time.Duration) (time.Duration, bool) {
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		return backoff, false
	}
	if apiErr.Status == http.StatusTooManyRequests || apiErr.Status >= 500 {
		if apiErr.RetryAfter > 0 {
			return time.Duration(apiErr.RetryAfter) * time.Second, false
		}
		return backoff, false
	}
	return 0, true
}

// runAnswer calls the method of a WebhookAnswer through the API, so a
// handler behaves the same under Poll as under WebhookHandler.
func runAnswer(ctx context.Context, c *Client, a *WebhookAnswer) error {
	switch a.Method {
	case "sendMessage":
		_, err := c.SendMessage(ctx, SendMessageRequest{ChatID: a.ChatID, Text: a.Text})
		return err
	case "answerCallback":
		return c.AnswerCallback(ctx, a.CallbackID, AnswerCallbackRequest{Text: a.Text, ShowAlert: a.ShowAlert, URL: a.URL})
	case "":
		return nil
	default:
		return fmt.Errorf("chatbot: unknown answer method %q", a.Method)
	}
}
