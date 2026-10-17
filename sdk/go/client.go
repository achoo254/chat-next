package chatbot

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// DefaultBaseURL is the Bot API base URL used when WithBaseURL is not given.
const DefaultBaseURL = "https://chat.hoandat.com/bot/v1"

const (
	defaultTimeout = 60 * time.Second
	defaultRetries = 3
	// responseMax bounds an API answer read into memory.
	responseMax = 16 << 20
)

// Client calls the Bot API with one bot token. It is safe for concurrent use.
type Client struct {
	token   string
	baseURL string
	http    *http.Client
	timeout time.Duration
	retries int
	// sleep waits between retries; tests replace it to run without delay.
	sleep func(ctx context.Context, d time.Duration) error
}

// Option configures a Client.
type Option func(*Client)

// WithBaseURL sets the API base URL, such as "https://chat.example.com/bot/v1".
func WithBaseURL(u string) Option {
	return func(c *Client) { c.baseURL = strings.TrimRight(u, "/") }
}

// WithHTTPClient sets the HTTP client. Its own Timeout, when set, must leave
// room for long polls (50 s plus the request timeout).
func WithHTTPClient(h *http.Client) Option {
	return func(c *Client) {
		if h != nil {
			c.http = h
		}
	}
}

// WithTimeout sets the timeout of one request attempt (default 60 s). A long
// poll gets its own wait added on top.
func WithTimeout(d time.Duration) Option {
	return func(c *Client) {
		if d > 0 {
			c.timeout = d
		}
	}
}

// WithRetries sets how many times a request is retried after
// 429 rate_limited or 503 unavailable (default 3; 0 disables retries).
func WithRetries(n int) Option {
	return func(c *Client) {
		if n >= 0 {
			c.retries = n
		}
	}
}

// NewClient returns a client for the bot token "<bot_id>:<secret>".
func NewClient(token string, opts ...Option) *Client {
	c := &Client{
		token:   token,
		baseURL: DefaultBaseURL,
		http:    http.DefaultClient,
		timeout: defaultTimeout,
		retries: defaultRetries,
		sleep:   sleepCtx,
	}
	for _, opt := range opts {
		opt(c)
	}
	return c
}

// envelope is every answer of the Bot API.
type envelope struct {
	Ok     bool               `json:"ok"`
	Result json.RawMessage    `json:"result"`
	Error  ErrorEnvelopeError `json:"error"`
}

// call sends a JSON request (body may be nil) and decodes the envelope's
// result into out (may be nil). The generated methods use it.
func (c *Client) call(ctx context.Context, method, path string, query url.Values, body, out any) error {
	var payload []byte
	contentType := ""
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("chatbot: encode %s %s: %w", method, path, err)
		}
		payload = b
		contentType = "application/json"
	}
	return c.do(ctx, method, path, query, contentType, payload, out)
}

// do runs a request with the retry policy of the contract: 429 rate_limited
// and 503 unavailable wait retry_after (or 1 s) and try again; a network
// error is retried only for requests without a body (GET), since a request
// with a body may already have run.
func (c *Client) do(ctx context.Context, method, path string, query url.Values, contentType string, payload []byte, out any) error {
	timeout := c.timeout
	if path == "/updates" {
		if s, err := strconv.Atoi(query.Get("timeout")); err == nil && s > 0 {
			timeout += time.Duration(s) * time.Second
		}
	}
	for attempt := 0; ; attempt++ {
		wait, err := c.attempt(ctx, timeout, method, path, query, contentType, payload, out)
		if err == nil {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		var apiErr *APIError
		retry := false
		if errors.As(err, &apiErr) {
			retry = apiErr.retryable()
		} else {
			retry = payload == nil && method == http.MethodGet
		}
		if !retry || attempt >= c.retries {
			return err
		}
		if err := c.sleep(ctx, wait); err != nil {
			return err
		}
	}
}

// attempt sends the request once. It returns how long to wait before a retry
// together with the error.
func (c *Client) attempt(ctx context.Context, timeout time.Duration, method, path string, query url.Values,
	contentType string, payload []byte, out any) (time.Duration, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	target := c.baseURL + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	var reader io.Reader
	if payload != nil {
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return 0, fmt.Errorf("chatbot: %s %s: %w", method, path, err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/json")
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return time.Second, fmt.Errorf("chatbot: %s %s: %w", method, path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, responseMax))
	if err != nil {
		return time.Second, fmt.Errorf("chatbot: %s %s: read answer: %w", method, path, err)
	}

	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil || (!env.Ok && env.Error.Code == "") {
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return 0, fmt.Errorf("chatbot: %s %s: the answer is not a Bot API envelope", method, path)
		}
		apiErr := &APIError{Status: resp.StatusCode, RetryAfter: headerRetryAfter(resp.Header)}
		return retryWait(apiErr.RetryAfter), apiErr
	}
	if !env.Ok {
		apiErr := &APIError{
			Status:      resp.StatusCode,
			Code:        env.Error.Code,
			Description: env.Error.Description,
			RetryAfter:  int(env.Error.RetryAfter),
		}
		if apiErr.RetryAfter <= 0 {
			apiErr.RetryAfter = headerRetryAfter(resp.Header)
		}
		return retryWait(apiErr.RetryAfter), apiErr
	}
	if out != nil && len(env.Result) > 0 {
		if err := json.Unmarshal(env.Result, out); err != nil {
			return 0, fmt.Errorf("chatbot: %s %s: decode result: %w", method, path, err)
		}
	}
	return 0, nil
}

// headerRetryAfter reads the Retry-After header (seconds or an HTTP date);
// 0 when absent or unreadable.
func headerRetryAfter(h http.Header) int {
	v := strings.TrimSpace(h.Get("Retry-After"))
	if v == "" {
		return 0
	}
	if n, err := strconv.Atoi(v); err == nil && n > 0 {
		return n
	}
	if t, err := http.ParseTime(v); err == nil {
		if s := int(time.Until(t).Round(time.Second) / time.Second); s > 0 {
			return s
		}
	}
	return 0
}

// retryWait is retry_after seconds, or 1 s when the server gave none.
func retryWait(seconds int) time.Duration {
	if seconds <= 0 {
		return time.Second
	}
	return time.Duration(seconds) * time.Second
}

// sleepCtx waits d or until ctx ends.
func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
