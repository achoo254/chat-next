package chat

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"sync"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/ids"
	"app.local/server/internal/linkpreview"
	"app.local/server/internal/ratelimit"
	"app.local/server/internal/store"
	"app.local/server/internal/store/testdb"
	"connectrpc.com/connect"
)

func TestMain(m *testing.M) {
	os.Exit(testdb.Main(m))
}

const testTenant = "primary"

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

// allowAll lets every action through (rate limits are tested on their own).
type allowAll struct{}

func (allowAll) Allow(ratelimit.Rule, string) bool { return true }

// recSink records what the service hands to the realtime gateway.
type recSink struct {
	mu       sync.Mutex
	frames   map[int64][]*appv1.UpdateFrame
	revoked  []int64
	forget   [][2]int64
	resyncs  int
	activity map[int64]int64
	viewers  map[int64][]int64
}

func newRecSink() *recSink {
	return &recSink{frames: map[int64][]*appv1.UpdateFrame{}, activity: map[int64]int64{}, viewers: map[int64][]int64{}}
}

func (r *recSink) SendUser(userID int64, f *appv1.ServerFrame) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.frames[userID] = append(r.frames[userID], f.GetUpdate())
}

func (r *recSink) ChatViewers(chatID int64) []int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.viewers[chatID]
}

func (r *recSink) SendChatViewer(userID, _ int64, f *appv1.ServerFrame) { r.SendUser(userID, f) }

func (r *recSink) ChatActivity(chatID, chatPts, _ int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.activity[chatID] = chatPts
}

func (r *recSink) RevokeSession(sessionID int64, _ appv1.SessionRevokeReason) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.revoked = append(r.revoked, sessionID)
}

func (r *recSink) ForgetChat(userID, chatID int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.forget = append(r.forget, [2]int64{userID, chatID})
}

func (r *recSink) ResyncAll(appv1.ResyncReason) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.resyncs++
}

func (r *recSink) updatesOf(userID int64) []*appv1.Update {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []*appv1.Update
	for _, f := range r.frames[userID] {
		out = append(out, f.GetUpdates()...)
	}
	return out
}

type harness struct {
	t    *testing.T
	st   *store.Store
	svc  *Service
	sink *recSink
	n    int
}

func newHarness(t *testing.T, mod func(*Config)) *harness {
	t.Helper()
	st := testdb.Open(t)
	ctx := context.Background()
	if err := st.EnsureTenant(ctx, testTenant, "hoandat.com", "hoandat.com"); err != nil {
		t.Fatal(err)
	}
	return newHarnessOn(t, st, testTenant, mod)
}

func newHarnessOn(t *testing.T, st *store.Store, tenant string, mod func(*Config)) *harness {
	t.Helper()
	gen, err := ids.NewSnowflake(int64(len(tenant)))
	if err != nil {
		t.Fatal(err)
	}
	cfg := Config{TenantID: tenant, PublicOrigin: "https://chat.example.test", AppScheme: "com.example.chat"}
	if mod != nil {
		mod(&cfg)
	}
	previews := linkpreview.NewService(st.Pool(), linkpreview.NewFetcher(linkpreview.Options{}), quiet)
	svc, err := New(cfg, Deps{Pool: st.Pool(), IDs: gen, Previews: previews, Limiter: allowAll{}, Logger: quiet})
	if err != nil {
		t.Fatal(err)
	}
	sink := newRecSink()
	svc.SetRealtime(sink, nil)
	if err := svc.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(svc.Stop)
	return &harness{t: t, st: st, svc: svc, sink: sink}
}

// user creates an account that anyone may add to groups.
func (h *harness) user(name string) int64 {
	h.t.Helper()
	h.n++
	ctx := context.Background()
	u, err := h.st.UpsertIdPUser(ctx, h.svc.cfg.TenantID, store.IdPProfile{
		Sub: fmt.Sprintf("acc_%s_%d", name, h.n), PreferredUsername: name, Name: name,
	})
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
	resp, err := h.svc.CreateGroup(context.Background(), owner, "group", members, false)
	if err != nil {
		h.t.Fatal(err)
	}
	if len(resp.GetFailedUserIds()) > 0 {
		h.t.Fatalf("CreateGroup failed for %v", resp.GetFailedUserIds())
	}
	return resp.GetChat().GetId()
}

func (h *harness) send(from, chatID int64, text string) *appv1.SendMessageResponse {
	h.t.Helper()
	resp, err := h.svc.SendMessage(context.Background(), from, &appv1.SendMessageRequest{ChatId: chatID, Text: text})
	if err != nil {
		h.t.Fatal(err)
	}
	return resp
}

// drain waits until the dispatcher delivered everything queued so far.
func (h *harness) drain() {
	h.t.Helper()
	h.svc.dispatch.stop()
	h.svc.dispatch = newDispatcher(h.svc)
	h.svc.dispatch.start()
}

// logOf returns a user's whole update log via GetDifference.
func (h *harness) logOf(userID int64) []*appv1.Update {
	h.t.Helper()
	var out []*appv1.Update
	pts := int64(0)
	for {
		resp, err := h.svc.GetDifference(context.Background(), userID, &appv1.GetDifferenceRequest{Pts: pts, ServerEpoch: h.svc.Epoch()})
		if err != nil {
			h.t.Fatal(err)
		}
		switch r := resp.GetResult().(type) {
		case *appv1.GetDifferenceResponse_Empty:
			return out
		case *appv1.GetDifferenceResponse_Full:
			return append(out, r.Full.GetUpdates()...)
		case *appv1.GetDifferenceResponse_Slice:
			out = append(out, r.Slice.GetUpdates()...)
			pts = resp.GetState().GetPts()
		default:
			h.t.Fatalf("difference from %d = %v", pts, resp)
		}
	}
}

func codeOf(err error) connect.Code {
	var ce *connect.Error
	if errors.As(err, &ce) {
		return ce.Code()
	}
	return connect.CodeUnknown
}

// newSessionFor is a minimal web session row of the user.
func newSessionFor(userID int64) store.NewSession {
	hash := make([]byte, 32)
	_, _ = rand.Read(hash)
	return store.NewSession{TokenHash: hash, TenantID: testTenant, UserID: userID, IdPClientID: "chat-web"}
}
