package gateway

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/auth"
	"app.local/server/internal/chat"
	"app.local/server/internal/store"
	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"
)

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

type fakeBackend struct {
	mu      sync.Mutex
	members map[int64][]int64 // chat -> members
	large   map[int64]bool
}

func (f *fakeBackend) MemberChats(_ context.Context, userID int64, chatIDs []int64) ([]chat.ChatAccess, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []chat.ChatAccess
	for _, id := range chatIDs {
		for _, m := range f.members[id] {
			if m == userID {
				out = append(out, chat.ChatAccess{ChatID: id, Large: f.large[id]})
			}
		}
	}
	return out, nil
}

func (f *fakeBackend) MembersAmong(_ context.Context, chatID int64, userIDs []int64) ([]int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []int64
	for _, u := range userIDs {
		for _, m := range f.members[chatID] {
			if m == u {
				out = append(out, u)
			}
		}
	}
	return out, nil
}

func (f *fakeBackend) PrivatePeers(context.Context, int64) (map[int64]int64, error) { return nil, nil }

func (f *fakeBackend) UserStatus(context.Context, int64, int64, bool) (*appv1.UserStatus, error) {
	return &appv1.UserStatus{}, nil
}

func (f *fakeBackend) SetLastSeen(context.Context, int64, time.Time) error { return nil }

func (f *fakeBackend) Epoch() int64 { return 7 }

// tokenSessions maps a cookie value "user-<id>" to a session of that user.
type tokenSessions struct{}

func (tokenSessions) Authenticate(_ context.Context, token string) (store.Session, error) {
	var id int64
	for _, c := range strings.TrimPrefix(token, "user-") {
		id = id*10 + int64(c-'0')
	}
	if !strings.HasPrefix(token, "user-") || id == 0 {
		return store.Session{}, auth.ErrNoSession
	}
	return store.Session{ID: id * 100, UserID: id, CreatedAt: time.Now()}, nil
}

type noTouch struct{}

func (noTouch) TouchSession(context.Context, int64, time.Duration) error { return nil }

type testGateway struct {
	srv *httptest.Server
	hub *Hub
	be  *fakeBackend
}

func newTestGateway(t *testing.T) *testGateway {
	t.Helper()
	be := &fakeBackend{members: map[int64][]int64{}, large: map[int64]bool{}}
	hub := NewHub(be, quiet)
	srv := httptest.NewServer(nil)
	g, err := New(Config{Hub: hub, Sessions: tokenSessions{}, Toucher: noTouch{}, Origins: auth.NewOrigins(srv.URL), Logger: quiet})
	if err != nil {
		t.Fatal(err)
	}
	srv.Config.Handler = g
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		hub.Shutdown(ctx)
		srv.Close()
	})
	return &testGateway{srv: srv, hub: hub, be: be}
}

type client struct {
	ws *websocket.Conn
}

func (tg *testGateway) connect(t *testing.T, userID int64) *client {
	t.Helper()
	h := http.Header{}
	h.Set("Origin", tg.srv.URL)
	h.Set("Cookie", auth.SessionCookieName+"=user-"+strings.TrimLeft(strings.Repeat("0", 1)+itoa(userID), "0"))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(tg.srv.URL, "http")+"/ws", &websocket.DialOptions{HTTPHeader: h})
	if err != nil {
		t.Fatal(err)
	}
	ws.SetReadLimit(1 << 20)
	t.Cleanup(func() { _ = ws.CloseNow() })
	c := &client{ws: ws}
	c.send(t, &appv1.ClientFrame{Frame: &appv1.ClientFrame_Hello{Hello: &appv1.ClientHelloFrame{}}})
	if f := c.read(t); f.GetHello().GetUserId() != userID || f.GetHello().GetServerEpoch() != 7 {
		t.Fatalf("hello = %v", f)
	}
	return c
}

func itoa(n int64) string {
	b := []byte{}
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

func (c *client) send(t *testing.T, f *appv1.ClientFrame) {
	t.Helper()
	b, err := proto.Marshal(f)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.ws.Write(context.Background(), websocket.MessageBinary, b); err != nil {
		t.Fatal(err)
	}
}

func (c *client) read(t *testing.T) *appv1.ServerFrame {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, data, err := c.ws.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	f := &appv1.ServerFrame{}
	if err := proto.Unmarshal(data, f); err != nil {
		t.Fatal(err)
	}
	return f
}

func TestBackpressureEndsInResync(t *testing.T) {
	tg := newTestGateway(t)
	c := tg.connect(t, 1)
	big := &appv1.ServerFrame{Frame: &appv1.ServerFrame_Update{Update: &appv1.UpdateFrame{Updates: []*appv1.Update{{
		Kind: &appv1.Update_MessageNew{MessageNew: &appv1.UpdateMessageNew{Message: &appv1.Message{Text: strings.Repeat("x", 64<<10)}}},
	}}}}}
	// The client reads nothing while the server queues far more than the
	// socket buffers and the send queue hold.
	for range 2 * sendQueue {
		tg.hub.SendUser(1, big)
	}
	sawResync := false
	for !sawResync {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_, data, err := c.ws.Read(ctx)
		cancel()
		if err != nil {
			t.Fatalf("socket ended without ResyncFrame: %v", err)
		}
		f := &appv1.ServerFrame{}
		if proto.Unmarshal(data, f) == nil && f.GetResync().GetReason() == appv1.ResyncReason_RESYNC_REASON_BACKPRESSURE {
			sawResync = true
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, _, err := c.ws.Read(ctx); websocket.CloseStatus(err) != websocket.StatusTryAgainLater {
		t.Fatalf("close after resync: %v", err)
	}
}

func TestLargeChatFanoutAndActivityHints(t *testing.T) {
	tg := newTestGateway(t)
	tg.be.members[50] = []int64{1, 2, 3}
	tg.be.large[50] = true
	viewer, other := tg.connect(t, 1), tg.connect(t, 2)
	outsider := tg.connect(t, 4)
	viewer.send(t, &appv1.ClientFrame{Frame: &appv1.ClientFrame_OpenChat{OpenChat: &appv1.OpenChatFrame{ChatId: 50}}})
	outsider.send(t, &appv1.ClientFrame{RequestId: 9, Frame: &appv1.ClientFrame_OpenChat{OpenChat: &appv1.OpenChatFrame{VisibleChatIds: []int64{50}}}})
	deadline := time.Now().Add(2 * time.Second)
	for len(tg.hub.ChatViewers(50)) != 1 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if v := tg.hub.ChatViewers(50); len(v) != 1 || v[0] != 1 {
		t.Fatalf("viewers = %v (non-members never view a chat)", v)
	}
	tg.hub.ChatActivity(50, 3, 9)
	tg.hub.ChatActivity(50, 4, 10)
	tg.hub.flushActivity(context.Background())
	f := other.read(t)
	a := f.GetUpdate().GetUpdates()[0].GetChatActivity()
	if a.GetChatId() != 50 || a.GetChatPts() != 4 || a.GetTopSeq() != 10 {
		t.Fatalf("coalesced hint = %v", f)
	}
	// The viewer gets the chat's log instead of hints; typing reaches only
	// those who have the chat open.
	other.send(t, &appv1.ClientFrame{Frame: &appv1.ClientFrame_OpenChat{OpenChat: &appv1.OpenChatFrame{ChatId: 50}}})
	time.Sleep(50 * time.Millisecond)
	viewer.send(t, &appv1.ClientFrame{Frame: &appv1.ClientFrame_Typing{Typing: &appv1.TypingFrame{ChatId: 50, Action: appv1.TypingAction_TYPING_ACTION_TYPING}}})
	if ty := other.read(t).GetTyping(); ty.GetUserId() != 1 || ty.GetChatId() != 50 {
		t.Fatalf("typing = %v", ty)
	}
	tg.hub.ForgetChat(2, 50)
	if v := tg.hub.ChatViewers(50); len(v) != 1 {
		t.Fatalf("viewers after forget = %v", v)
	}
}

func TestShutdownAsksClientsToReconnect(t *testing.T) {
	tg := newTestGateway(t)
	c := tg.connect(t, 3)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	go tg.hub.Shutdown(ctx)
	if f := c.read(t); f.GetResync().GetReason() != appv1.ResyncReason_RESYNC_REASON_SERVER_RESTART {
		t.Fatalf("shutdown frame = %v", f)
	}
	deadline := time.Now().Add(2 * time.Second)
	for tg.hub.Connected() != 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if n := tg.hub.Connected(); n != 0 {
		t.Fatalf("%d sockets left after shutdown", n)
	}
	h := http.Header{}
	h.Set("Origin", tg.srv.URL)
	h.Set("Cookie", auth.SessionCookieName+"=user-3")
	dctx, dcancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer dcancel()
	ws, _, err := websocket.Dial(dctx, "ws"+strings.TrimPrefix(tg.srv.URL, "http")+"/ws", &websocket.DialOptions{HTTPHeader: h})
	if err == nil {
		b, _ := proto.Marshal(&appv1.ClientFrame{Frame: &appv1.ClientFrame_Hello{Hello: &appv1.ClientHelloFrame{}}})
		_ = ws.Write(dctx, websocket.MessageBinary, b)
		if _, _, err := ws.Read(dctx); websocket.CloseStatus(err) != websocket.StatusTryAgainLater {
			t.Fatalf("connection during shutdown: %v", err)
		}
	}
}
