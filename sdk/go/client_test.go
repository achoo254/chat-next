package chatbot

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestCallSendsJSONWithBearerAndDecodesResult(t *testing.T) {
	f := newFakeAPI(t)
	f.ok("POST /bot/v1/messages", map[string]any{"chat": map[string]any{"id": 42, "type": "private"}, "seq": 7, "date": 1, "text": "hi"})
	msg, err := f.client(nil).SendMessage(context.Background(), SendMessageRequest{ChatID: 42, Text: "hi"})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if msg.Seq != 7 || msg.Chat.ID != 42 || msg.Text != "hi" {
		t.Fatalf("result = %+v", msg)
	}
	req := f.requests()[0]
	if got := req.Header.Get("Authorization"); got != "Bearer "+testToken {
		t.Errorf("Authorization = %q", got)
	}
	if got := req.Header.Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q", got)
	}
	var body map[string]any
	if err := json.Unmarshal(req.Body, &body); err != nil || body["chat_id"] != float64(42) || body["text"] != "hi" {
		t.Errorf("body = %s (%v)", req.Body, err)
	}
}

func TestGetSendsNoBody(t *testing.T) {
	f := newFakeAPI(t)
	f.ok("GET /bot/v1/me", map[string]any{"id": 1, "is_bot": true, "name": "B", "username": "b_bot", "privacy": true, "tier": "default"})
	me, err := f.client(nil).GetMe(context.Background())
	if err != nil || me.Username != "b_bot" {
		t.Fatalf("GetMe = %+v, %v", me, err)
	}
	req := f.requests()[0]
	if len(req.Body) != 0 || req.Header.Get("Content-Type") != "" {
		t.Errorf("GET carried a body %q (%s)", req.Body, req.Header.Get("Content-Type"))
	}
}

func TestErrorEnvelopeBecomesAPIError(t *testing.T) {
	f := newFakeAPI(t)
	f.handle("POST /bot/v1/messages", func(w http.ResponseWriter, _ *http.Request) {
		writeErr(w, http.StatusForbidden, "no_consent", 0)
	})
	_, err := f.client(nil).SendMessage(context.Background(), SendMessageRequest{ChatID: 1, Text: "x"})
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("error %v is not an *APIError", err)
	}
	if apiErr.Status != 403 || apiErr.Code != "no_consent" || apiErr.Description != "detail of no_consent" || apiErr.RetryAfter != 0 {
		t.Errorf("APIError = %+v", apiErr)
	}
	if strings.Contains(err.Error(), testToken) || strings.Contains(err.Error(), "secret-token") {
		t.Errorf("error text leaks the token: %q", err)
	}
	if f.count("POST /bot/v1/messages") != 1 {
		t.Errorf("a 403 was retried")
	}
}

func TestNonEnvelopeAnswerIsAPIErrorWithoutCode(t *testing.T) {
	f := newFakeAPI(t)
	f.handle("GET /bot/v1/me", func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "<html>bad gateway</html>", http.StatusBadGateway)
	})
	_, err := f.client(nil).GetMe(context.Background())
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != 502 || apiErr.Code != "" {
		t.Fatalf("err = %#v", err)
	}
	if f.count("GET /bot/v1/me") != 1 {
		t.Errorf("a 502 was retried")
	}
}

func TestRetriesRateLimitAndUnavailable(t *testing.T) {
	f := newFakeAPI(t)
	var n atomic.Int32
	f.handle("POST /bot/v1/messages", func(w http.ResponseWriter, _ *http.Request) {
		switch n.Add(1) {
		case 1:
			writeErr(w, http.StatusTooManyRequests, "rate_limited", 3)
		case 2:
			w.Header().Set("Retry-After", "2")
			writeErr(w, http.StatusServiceUnavailable, "unavailable", 0)
		case 3:
			writeErr(w, http.StatusServiceUnavailable, "unavailable", 0)
		default:
			writeOK(w, map[string]any{"chat": map[string]any{"id": 1}, "seq": 1, "date": 1})
		}
	})
	var waits []time.Duration
	if _, err := f.client(&waits).SendMessage(context.Background(), SendMessageRequest{ChatID: 1, Text: "x"}); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	want := []time.Duration{3 * time.Second, 2 * time.Second, time.Second}
	if len(waits) != len(want) {
		t.Fatalf("waits = %v, want %v", waits, want)
	}
	for i := range want {
		if waits[i] != want[i] {
			t.Errorf("wait %d = %v, want %v", i, waits[i], want[i])
		}
	}
}

func TestRetriesStopAfterLimit(t *testing.T) {
	f := newFakeAPI(t)
	f.handle("GET /bot/v1/me", func(w http.ResponseWriter, _ *http.Request) {
		writeErr(w, http.StatusTooManyRequests, "rate_limited", 1)
	})
	_, err := f.client(nil, WithRetries(2)).GetMe(context.Background())
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Code != "rate_limited" || apiErr.RetryAfter != 1 {
		t.Fatalf("err = %v", err)
	}
	if got := f.count("GET /bot/v1/me"); got != 3 {
		t.Errorf("attempts = %d, want 3", got)
	}
}

func TestOtherTooManyRequestsCodesAreNotRetried(t *testing.T) {
	f := newFakeAPI(t)
	f.handle("POST /bot/v1/messages:bulk", func(w http.ResponseWriter, _ *http.Request) {
		writeErr(w, http.StatusTooManyRequests, "bulk_quota", 0)
	})
	_, err := f.client(nil).SendBulk(context.Background(), BulkRequest{All: true, Text: "x"})
	if err == nil || f.count("POST /bot/v1/messages:bulk") != 1 {
		t.Fatalf("err = %v, attempts = %d", err, f.count("POST /bot/v1/messages:bulk"))
	}
}

func TestNetworkErrorRetriedOnlyForGet(t *testing.T) {
	f := newFakeAPI(t)
	abort := func(http.ResponseWriter, *http.Request) { panic(http.ErrAbortHandler) }
	f.handle("GET /bot/v1/me", abort)
	f.handle("POST /bot/v1/messages", abort)
	c := f.client(nil)
	if _, err := c.GetMe(context.Background()); err == nil {
		t.Fatal("GetMe succeeded on a dropped connection")
	}
	if got := f.count("GET /bot/v1/me"); got != 4 {
		t.Errorf("GET attempts = %d, want 4", got)
	}
	if _, err := c.SendMessage(context.Background(), SendMessageRequest{ChatID: 1, Text: "x"}); err == nil {
		t.Fatal("SendMessage succeeded on a dropped connection")
	}
	if got := f.count("POST /bot/v1/messages"); got != 1 {
		t.Errorf("POST attempts = %d, want 1", got)
	}
}

func TestRetryWaitHonorsContext(t *testing.T) {
	f := newFakeAPI(t)
	f.handle("GET /bot/v1/me", func(w http.ResponseWriter, _ *http.Request) {
		writeErr(w, http.StatusTooManyRequests, "rate_limited", 3600)
	})
	c := NewClient(testToken, WithBaseURL(f.srv.URL+"/bot/v1"))
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := c.GetMe(ctx)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want deadline exceeded", err)
	}
	if time.Since(start) > 5*time.Second {
		t.Errorf("the retry wait ignored the context")
	}
}

func TestHeaderRetryAfter(t *testing.T) {
	h := http.Header{}
	if headerRetryAfter(h) != 0 {
		t.Error("absent header")
	}
	h.Set("Retry-After", "7")
	if headerRetryAfter(h) != 7 {
		t.Error("seconds")
	}
	h.Set("Retry-After", time.Now().Add(10*time.Second).UTC().Format(http.TimeFormat))
	if got := headerRetryAfter(h); got < 8 || got > 11 {
		t.Errorf("date = %d", got)
	}
	h.Set("Retry-After", "soon")
	if headerRetryAfter(h) != 0 {
		t.Error("garbage")
	}
}
