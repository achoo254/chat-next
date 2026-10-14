package hooks_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/chat"
	"app.local/server/internal/hooks"
	"app.local/server/internal/ids"
	"app.local/server/internal/linkpreview"
	"app.local/server/internal/ratelimit"
	"app.local/server/internal/store"
	"app.local/server/internal/store/testdb"
)

func TestMain(m *testing.M) {
	os.Exit(testdb.Main(m))
}

const tenant = "primary"

// syncBuffer collects log output from concurrent writers.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// sink records realtime frames; presence says who is online.
type sink struct {
	mu     sync.Mutex
	frames map[int64][]*appv1.UpdateFrame
	online map[int64]bool
}

func (s *sink) SendUser(userID int64, f *appv1.ServerFrame) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.frames[userID] = append(s.frames[userID], f.GetUpdate())
}
func (s *sink) ChatViewers(int64) []int64                            { return nil }
func (s *sink) SendChatViewer(userID, _ int64, f *appv1.ServerFrame) { s.SendUser(userID, f) }
func (s *sink) ChatActivity(int64, int64, int64)                     {}
func (s *sink) RevokeSession(int64, appv1.SessionRevokeReason)       {}
func (s *sink) ForgetChat(int64, int64)                              {}
func (s *sink) ResyncAll(appv1.ResyncReason)                         {}
func (s *sink) Online(userID int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.online[userID]
}
func (s *sink) OnlineUsers() []int64 { return nil }

func (s *sink) updates(userID int64) []*appv1.Update {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []*appv1.Update
	for _, f := range s.frames[userID] {
		out = append(out, f.GetUpdates()...)
	}
	return out
}

type harness struct {
	t     testing.TB
	st    *store.Store
	chat  *chat.Service
	hooks *hooks.Service
	sink  *sink
	srv   *httptest.Server
	logs  *syncBuffer
	n     int
}

// allowAll disables rate limits outside the rate limit test.
type allowAll struct{}

func (allowAll) Allow(ratelimit.Rule, string) bool { return true }

func newHarness(t testing.TB, limiter ratelimit.Limiter) *harness {
	t.Helper()
	ctx := context.Background()
	st := testdb.Open(t)
	if err := st.EnsureTenant(ctx, tenant, "hoandat.com", "hoandat.com"); err != nil {
		t.Fatal(err)
	}
	gen, err := ids.NewSnowflake(7)
	if err != nil {
		t.Fatal(err)
	}
	logs := &syncBuffer{}
	logger := slog.New(slog.NewTextHandler(logs, nil))
	srv := httptest.NewUnstartedServer(nil)
	srv.Config.ErrorLog = slog.NewLogLogger(logger.Handler(), slog.LevelWarn)
	srv.Start()
	t.Cleanup(srv.Close)
	origin := srv.URL
	previews := linkpreview.NewService(st.Pool(), linkpreview.NewFetcher(linkpreview.Options{}), logger)
	chatSvc, err := chat.New(chat.Config{TenantID: tenant, PublicOrigin: origin, AppScheme: "com.example.chat"},
		chat.Deps{Pool: st.Pool(), IDs: gen, Previews: previews, Limiter: allowAll{}, Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	sk := &sink{frames: map[int64][]*appv1.UpdateFrame{}, online: map[int64]bool{}}
	chatSvc.SetRealtime(sk, sk)
	if err := chatSvc.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(chatSvc.Stop)
	hookSvc, err := hooks.New(hooks.Config{TenantID: tenant, PublicOrigin: origin, AppScheme: "com.example.chat"},
		st.Pool(), chatSvc, limiter, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	for _, route := range hooks.Routes {
		mux.Handle(route, hookSvc)
	}
	srv.Config.Handler = mux
	return &harness{t: t, st: st, chat: chatSvc, hooks: hookSvc, sink: sk, srv: srv, logs: logs}
}

func (h *harness) user(name string) int64 {
	h.t.Helper()
	h.n++
	ctx := context.Background()
	u, err := h.st.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: fmt.Sprintf("acc_%s_%d", name, h.n), PreferredUsername: name, Name: name})
	if err != nil {
		h.t.Fatal(err)
	}
	if _, err := h.st.Pool().Exec(ctx, `INSERT INTO privacy_settings (user_id, add_to_groups) VALUES ($1, 1)`, u.ID); err != nil {
		h.t.Fatal(err)
	}
	return u.ID
}

func (h *harness) group(owner int64, members ...int64) int64 {
	h.t.Helper()
	resp, err := h.chat.CreateGroup(context.Background(), owner, "Vận hành", members, false)
	if err != nil {
		h.t.Fatal(err)
	}
	return resp.GetChat().GetId()
}

func (h *harness) create(me, chatID int64, name string, f appv1.IncomingHookFormat) (*appv1.IncomingHook, string) {
	h.t.Helper()
	resp, err := h.hooks.CreateIncomingHook(context.Background(), me, &appv1.CreateIncomingHookRequest{ChatId: chatID, Name: name, Format: f})
	if err != nil {
		h.t.Fatal(err)
	}
	return resp.GetHook(), resp.GetUrl()
}

type reply struct {
	status int
	body   string
	header http.Header
}

func (r reply) json(t testing.TB) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal([]byte(r.body), &out); err != nil {
		t.Fatalf("not JSON (%d): %q", r.status, r.body)
	}
	return out
}

func (r reply) seq(t testing.TB) int64 {
	t.Helper()
	if r.status != http.StatusOK {
		t.Fatalf("status %d: %s", r.status, r.body)
	}
	v, ok := r.json(t)["seq"].(float64)
	if !ok {
		t.Fatalf("no seq in %s", r.body)
	}
	return int64(v)
}

// post sends body to url (a full hook URL of the test server).
func (h *harness) post(url, contentType, body string) reply {
	h.t.Helper()
	return h.postHost(url, "", contentType, body)
}

func (h *harness) postHost(url, host, contentType, body string) reply {
	h.t.Helper()
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, url, strings.NewReader(body))
	if err != nil {
		h.t.Fatal(err)
	}
	if host != "" {
		req.Host = host
	}
	if contentType == "" {
		contentType = "application/json"
	}
	req.Header.Set("Content-Type", contentType)
	resp, err := h.srv.Client().Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		h.t.Fatal(err)
	}
	return reply{status: resp.StatusCode, body: string(b), header: resp.Header}
}

// history returns the chat's messages as me sees them, oldest first.
func (h *harness) history(me, chatID int64) []*appv1.Message {
	h.t.Helper()
	resp, err := h.chat.GetHistory(context.Background(), me, &appv1.GetHistoryRequest{ChatId: chatID, Limit: 100})
	if err != nil {
		h.t.Fatal(err)
	}
	var out []*appv1.Message
	for _, m := range resp.GetMessages() {
		if m.GetAction() == nil {
			out = append(out, m)
		}
	}
	return out
}

func (h *harness) message(me, chatID, seq int64) *appv1.Message {
	h.t.Helper()
	for _, m := range h.history(me, chatID) {
		if m.GetSeq() == seq {
			return m
		}
	}
	h.t.Fatalf("message %d not found", seq)
	return nil
}

func (h *harness) hook(me int64, id string) *appv1.IncomingHook {
	h.t.Helper()
	resp, err := h.hooks.GetIncomingHook(context.Background(), me, id)
	if err != nil {
		h.t.Fatal(err)
	}
	return resp.GetHook()
}

// eventually polls cond for up to 2 seconds.
func eventually(t testing.TB, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
