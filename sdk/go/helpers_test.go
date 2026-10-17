package chatbot

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

const testToken = "123:secret-token-value"

// recorded is one request the fake API received.
type recorded struct {
	Method string
	Path   string
	Query  string
	Header http.Header
	Body   []byte
}

// fakeAPI is an in-process Bot API: route answers "METHOD /path" requests
// and every request is recorded.
type fakeAPI struct {
	t      *testing.T
	srv    *httptest.Server
	mu     sync.Mutex
	reqs   []recorded
	routes map[string]http.HandlerFunc
}

func newFakeAPI(t *testing.T) *fakeAPI {
	t.Helper()
	f := &fakeAPI{t: t, routes: map[string]http.HandlerFunc{}}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.reqs = append(f.reqs, recorded{Method: r.Method, Path: r.URL.Path, Query: r.URL.RawQuery, Header: r.Header.Clone(), Body: body})
		h := f.routes[r.Method+" "+r.URL.Path]
		f.mu.Unlock()
		if h == nil {
			writeErr(w, http.StatusNotFound, "not_found", 0)
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		h(w, r)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

// handle sets the answer of "METHOD /path".
func (f *fakeAPI) handle(route string, h http.HandlerFunc) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.routes[route] = h
}

// ok answers route with {"ok": true, "result": result}.
func (f *fakeAPI) ok(route string, result any) {
	f.handle(route, func(w http.ResponseWriter, _ *http.Request) { writeOK(w, result) })
}

func (f *fakeAPI) requests() []recorded {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]recorded(nil), f.reqs...)
}

// count is how many requests hit "METHOD /path".
func (f *fakeAPI) count(route string) int {
	n := 0
	for _, r := range f.requests() {
		if r.Method+" "+r.Path == route {
			n++
		}
	}
	return n
}

// client returns a client of the fake API whose retries do not sleep; the
// waits are appended to *waits when waits is not nil.
func (f *fakeAPI) client(waits *[]time.Duration, opts ...Option) *Client {
	c := NewClient(testToken, append([]Option{WithBaseURL(f.srv.URL + "/bot/v1")}, opts...)...)
	var mu sync.Mutex
	c.sleep = func(ctx context.Context, d time.Duration) error {
		mu.Lock()
		if waits != nil {
			*waits = append(*waits, d)
		}
		mu.Unlock()
		return ctx.Err()
	}
	return c
}

func writeOK(w http.ResponseWriter, result any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "result": result})
}

func writeErr(w http.ResponseWriter, status int, code string, retryAfter int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	e := map[string]any{"code": code, "description": "detail of " + code}
	if retryAfter > 0 {
		e["retry_after"] = retryAfter
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": e})
}
