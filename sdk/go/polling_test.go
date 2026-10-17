package chatbot

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// pollServer answers getUpdates from a script: one entry per request (an
// update list or an error status), then waits until the client gives up.
type pollServer struct {
	mu      sync.Mutex
	queries []url.Values
	script  []func(w http.ResponseWriter)
}

func (p *pollServer) serve(w http.ResponseWriter, r *http.Request) {
	p.mu.Lock()
	p.queries = append(p.queries, r.URL.Query())
	var step func(w http.ResponseWriter)
	if len(p.script) > 0 {
		step, p.script = p.script[0], p.script[1:]
	}
	p.mu.Unlock()
	if step == nil {
		<-r.Context().Done()
		return
	}
	step(w)
}

func (p *pollServer) seen() []url.Values {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]url.Values(nil), p.queries...)
}

func updates(ids ...int64) func(w http.ResponseWriter) {
	list := make([]map[string]any, 0, len(ids))
	for _, id := range ids {
		list = append(list, map[string]any{"update_id": id, "message": map[string]any{"chat": map[string]any{"id": 1}, "seq": id, "date": 1, "text": "hi"}})
	}
	return func(w http.ResponseWriter) { writeOK(w, list) }
}

func failing(status int, code string, retryAfter int) func(w http.ResponseWriter) {
	return func(w http.ResponseWriter) { writeErr(w, status, code, retryAfter) }
}

// waitFor polls cond until it holds or a second passes.
func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not reached")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestPollAdvancesOffsetAndSurvivesHandlerErrors(t *testing.T) {
	f := newFakeAPI(t)
	p := &pollServer{script: []func(http.ResponseWriter){updates(10, 11), updates(12)}}
	f.handle("GET /bot/v1/updates", p.serve)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var mu sync.Mutex
	var handled []int64
	done := make(chan error, 1)
	go func() {
		done <- Poll(ctx, f.client(nil), func(_ context.Context, u Update) (*WebhookAnswer, error) {
			mu.Lock()
			handled = append(handled, u.UpdateID)
			mu.Unlock()
			if u.UpdateID == 10 {
				return nil, errors.New("handler failed")
			}
			if u.UpdateID == 11 {
				panic("handler panicked")
			}
			return nil, nil
		}, nil)
	}()
	waitFor(t, func() bool { return len(p.seen()) >= 3 })
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("Poll = %v, want nil after cancel", err)
	}
	q := p.seen()
	if q[0].Get("offset") != "" || q[0].Get("timeout") != "50" {
		t.Errorf("first poll = %v", q[0])
	}
	if q[1].Get("offset") != "12" || q[2].Get("offset") != "13" {
		t.Errorf("offsets = %v, %v", q[1], q[2])
	}
	mu.Lock()
	defer mu.Unlock()
	if len(handled) != 3 || handled[0] != 10 || handled[2] != 12 {
		t.Errorf("handled = %v", handled)
	}
}

func TestPollStopsOnConflict(t *testing.T) {
	f := newFakeAPI(t)
	p := &pollServer{script: []func(http.ResponseWriter){failing(http.StatusConflict, "conflict", 0)}}
	f.handle("GET /bot/v1/updates", p.serve)
	err := Poll(context.Background(), f.client(nil), func(context.Context, Update) (*WebhookAnswer, error) { return nil, nil }, nil)
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusConflict || apiErr.Code != "conflict" {
		t.Fatalf("Poll = %v, want 409 conflict", err)
	}
}

func TestPollBacksOffOnServerErrors(t *testing.T) {
	f := newFakeAPI(t)
	p := &pollServer{script: []func(http.ResponseWriter){
		failing(http.StatusInternalServerError, "internal", 0),
		failing(http.StatusBadGateway, "", 0),
		failing(http.StatusTooManyRequests, "rate_limited", 7),
		updates(1),
	}}
	f.handle("GET /bot/v1/updates", p.serve)
	var waits []time.Duration
	var got atomic.Int64
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- Poll(ctx, f.client(&waits, WithRetries(0)), func(_ context.Context, u Update) (*WebhookAnswer, error) {
			got.Store(u.UpdateID)
			return nil, nil
		}, &PollOptions{Timeout: 5})
	}()
	waitFor(t, func() bool { return got.Load() == 1 })
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("Poll = %v", err)
	}
	want := []time.Duration{time.Second, 2 * time.Second, 7 * time.Second}
	if len(waits) != len(want) {
		t.Fatalf("waits = %v, want %v", waits, want)
	}
	for i := range want {
		if waits[i] != want[i] {
			t.Errorf("wait %d = %v, want %v", i, waits[i], want[i])
		}
	}
	if p.seen()[0].Get("timeout") != "5" {
		t.Errorf("timeout option not sent: %v", p.seen()[0])
	}
}

func TestPollStopsOnUnauthorized(t *testing.T) {
	f := newFakeAPI(t)
	p := &pollServer{script: []func(http.ResponseWriter){failing(http.StatusUnauthorized, "unauthorized", 0)}}
	f.handle("GET /bot/v1/updates", p.serve)
	err := Poll(context.Background(), f.client(nil), func(context.Context, Update) (*WebhookAnswer, error) { return nil, nil }, nil)
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusUnauthorized {
		t.Fatalf("Poll = %v, want 401", err)
	}
}

func TestPollRunsHandlerAnswers(t *testing.T) {
	f := newFakeAPI(t)
	p := &pollServer{script: []func(http.ResponseWriter){updates(4)}}
	f.handle("GET /bot/v1/updates", p.serve)
	f.ok("POST /bot/v1/messages", map[string]any{"chat": map[string]any{"id": 1}, "seq": 1, "date": 1})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- Poll(ctx, f.client(nil), func(context.Context, Update) (*WebhookAnswer, error) {
			return &WebhookAnswer{Method: "sendMessage", ChatID: 1, Text: "ok"}, nil
		}, nil)
	}()
	waitFor(t, func() bool { return f.count("POST /bot/v1/messages") == 1 })
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("Poll = %v", err)
	}
	for _, r := range f.requests() {
		if r.Path == "/bot/v1/messages" {
			var m map[string]any
			if err := json.Unmarshal(r.Body, &m); err != nil || m["chat_id"] != float64(1) || m["text"] != "ok" {
				t.Errorf("answer request = %s", r.Body)
			}
		}
	}
}

func TestPollAcknowledgesHandledUpdatesOnStop(t *testing.T) {
	f := newFakeAPI(t)
	p := &pollServer{script: []func(http.ResponseWriter){updates(4, 5), updates()}}
	f.handle("GET /bot/v1/updates", p.serve)
	ctx, cancel := context.WithCancel(context.Background())
	var handled []int64
	err := Poll(ctx, f.client(nil), func(_ context.Context, u Update) (*WebhookAnswer, error) {
		handled = append(handled, u.UpdateID)
		cancel()
		return nil, nil
	}, nil)
	if err != nil {
		t.Fatalf("Poll = %v", err)
	}
	if len(handled) != 1 {
		t.Errorf("handled after stop: %v", handled)
	}
	q := p.seen()
	if len(q) != 2 || q[1].Get("offset") != "5" || q[1].Get("timeout") != "" {
		t.Errorf("acknowledgement = %v", q)
	}
}
