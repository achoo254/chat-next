package gateway

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
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
	// readOnly: members who may not post in the chat.
	readOnly map[int64]map[int64]bool
	// hideTyping: typer -> viewers their privacy settings hide typing from.
	hideTyping map[int64]map[int64]bool
}

func (f *fakeBackend) MemberChats(_ context.Context, userID int64, chatIDs []int64) ([]chat.ChatAccess, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []chat.ChatAccess
	for _, id := range chatIDs {
		for _, m := range f.members[id] {
			if m == userID {
				out = append(out, chat.ChatAccess{ChatID: id, Large: f.large[id], CanSend: !f.readOnly[id][userID]})
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

func (f *fakeBackend) TypingViewers(_ context.Context, chatID, typer int64, bot bool, viewing []int64) ([]int64, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []int64
	for _, m := range f.members[chatID] {
		if m == typer || (f.large[chatID] && !slices.Contains(viewing, m)) || (!bot && f.hideTyping[typer][m]) {
			continue
		}
		out = append(out, m)
	}
	return out, f.large[chatID], nil
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

// AuthenticateBearer maps a hello token "native-<id>" to a native session of
// that user; any other token (a web session's included) is refused.
func (tokenSessions) AuthenticateBearer(ctx context.Context, token string) (store.Session, error) {
	rest, ok := strings.CutPrefix(token, "native-")
	if !ok {
		return store.Session{}, auth.ErrNoSession
	}
	s, err := tokenSessions{}.Authenticate(ctx, "user-"+rest)
	if err != nil {
		return store.Session{}, err
	}
	s.Platform = store.PlatformIOS
	return s, nil
}

// fakeToucher reports sessions active unless revoked.
type fakeToucher struct {
	mu      sync.Mutex
	revoked map[int64]bool
}

func (f *fakeToucher) TouchSession(_ context.Context, id int64, _ time.Duration) (store.SessionStatus, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.revoked[id] {
		return store.SessionStatus{RevokeReason: int16(appv1.SessionRevokeReason_SESSION_REVOKE_REASON_REVOKED_BY_USER)}, nil
	}
	return store.SessionStatus{Active: true}, nil
}

func (f *fakeToucher) revoke(id int64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.revoked[id] = true
}

type testGateway struct {
	srv   *httptest.Server
	hub   *Hub
	be    *fakeBackend
	touch *fakeToucher
}

func newTestGateway(t *testing.T) *testGateway {
	t.Helper()
	be := &fakeBackend{members: map[int64][]int64{}, large: map[int64]bool{}, readOnly: map[int64]map[int64]bool{}, hideTyping: map[int64]map[int64]bool{}}
	hub := NewHub(be, quiet)
	srv := httptest.NewServer(nil)
	touch := &fakeToucher{revoked: map[int64]bool{}}
	g, err := New(Config{Hub: hub, Sessions: tokenSessions{}, Toucher: touch, Origins: auth.NewOrigins(srv.URL), Logger: quiet,
		SessionCheckInterval: 50 * time.Millisecond})
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
	return &testGateway{srv: srv, hub: hub, be: be, touch: touch}
}

type client struct {
	ws *websocket.Conn
}

// dialHello opens a socket for the user and sends ClientHelloFrame without
// waiting for the answer.
func (tg *testGateway) dialHello(t *testing.T, userID int64) *client {
	t.Helper()
	h := http.Header{}
	h.Set("Origin", tg.srv.URL)
	h.Set("Cookie", auth.SessionCookieName+"=user-"+itoa(userID))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(tg.srv.URL, "http")+"/ws", &websocket.DialOptions{HTTPHeader: h})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ws.CloseNow() })
	c := &client{ws: ws}
	c.send(t, &appv1.ClientFrame{Frame: &appv1.ClientFrame_Hello{Hello: &appv1.ClientHelloFrame{}}})
	return c
}

// closeStatus reads until the socket ends and returns its close status.
func (c *client) closeStatus(t *testing.T) websocket.StatusCode {
	t.Helper()
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_, _, err := c.ws.Read(ctx)
		cancel()
		if err != nil {
			return websocket.CloseStatus(err)
		}
	}
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

func TestTypingReachesTheListAndFollowsPrivacy(t *testing.T) {
	tg := newTestGateway(t)
	tg.be.members[70] = []int64{1, 2, 3, 9}
	tg.be.hideTyping[1] = map[int64]bool{3: true}
	typer, lister, hidden := tg.connect(t, 1), tg.connect(t, 2), tg.connect(t, 3)
	outsider := tg.connect(t, 4)
	typer.send(t, &appv1.ClientFrame{Frame: &appv1.ClientFrame_OpenChat{OpenChat: &appv1.OpenChatFrame{ChatId: 70}}})
	time.Sleep(50 * time.Millisecond)
	typer.send(t, &appv1.ClientFrame{Frame: &appv1.ClientFrame_Typing{Typing: &appv1.TypingFrame{ChatId: 70, Action: appv1.TypingAction_TYPING_ACTION_TYPING}}})
	// A member of a small chat sees it in the dialog list without opening the chat.
	if ty := lister.read(t).GetTyping(); ty.GetUserId() != 1 || ty.GetChatId() != 70 {
		t.Fatalf("typing in the list = %v", ty)
	}
	// Nothing reaches a member the typer's privacy excludes, or a non-member:
	// their next frame is the answer to a ping sent after the typing.
	for _, c := range []*client{hidden, outsider} {
		c.send(t, &appv1.ClientFrame{RequestId: 11, Frame: &appv1.ClientFrame_Ping{Ping: &appv1.PingFrame{}}})
		if f := c.read(t); f.GetPong().GetRequestId() != 11 {
			t.Fatalf("next frame = %v, want the pong", f)
		}
	}
	// A bot's chat action reaches every member.
	tg.be.hideTyping[9] = map[int64]bool{3: true}
	tg.hub.BotTyping(9, 70, 0, appv1.TypingAction_TYPING_ACTION_UPLOADING_PHOTO)
	if ty := hidden.read(t).GetTyping(); ty.GetAction() != appv1.TypingAction_TYPING_ACTION_UPLOADING_PHOTO {
		t.Fatalf("bot action = %v", ty)
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
	// Keep reading like a real client, so the close handshake completes
	// instead of waiting out the server's close timeout on a slow machine.
	go func() {
		for {
			if _, _, err := c.ws.Read(context.Background()); err != nil {
				return
			}
		}
	}()
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

func TestSessionRevokedBeforeRegisterClosesSocket(t *testing.T) {
	tg := newTestGateway(t)
	// The handshake authenticated the session; it was revoked before the
	// socket registered, so the outbox's session_revoked missed it.
	tg.touch.revoke(500)
	c := tg.dialHello(t, 5)
	if f := c.read(t); f.GetSessionRevoked().GetReason() != appv1.SessionRevokeReason_SESSION_REVOKE_REASON_REVOKED_BY_USER {
		t.Fatalf("first frame = %v, want SessionRevokedFrame", f)
	}
	if st := c.closeStatus(t); st != websocket.StatusPolicyViolation {
		t.Fatalf("close status = %v", st)
	}
	deadline := time.Now().Add(2 * time.Second)
	for tg.hub.Connected() != 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if n := tg.hub.Connected(); n != 0 {
		t.Fatalf("%d sockets still registered", n)
	}
}

func TestPeriodicSessionCheckClosesRevokedSocket(t *testing.T) {
	tg := newTestGateway(t)
	c := tg.connect(t, 6)
	tg.touch.revoke(600)
	if f := c.read(t); f.GetSessionRevoked() == nil {
		t.Fatalf("frame = %v, want SessionRevokedFrame", f)
	}
	if st := c.closeStatus(t); st != websocket.StatusPolicyViolation {
		t.Fatalf("close status = %v", st)
	}
}

func TestSocketsPerSessionAreCapped(t *testing.T) {
	tg := newTestGateway(t)
	for range maxSocketsPerSession {
		tg.connect(t, 7)
	}
	extra := tg.dialHello(t, 7)
	if st := extra.closeStatus(t); st != websocket.StatusPolicyViolation {
		t.Fatalf("socket over the cap: close status %v", st)
	}
	if n := tg.hub.Connected(); n != maxSocketsPerSession {
		t.Fatalf("%d sockets, want %d", n, maxSocketsPerSession)
	}
}

func TestOpenChatFramesAreRateLimited(t *testing.T) {
	tg := newTestGateway(t)
	c := tg.connect(t, 8)
	for i := range int(openChatRule.Burst) + 5 {
		c.send(t, &appv1.ClientFrame{RequestId: int64(i + 1), Frame: &appv1.ClientFrame_OpenChat{OpenChat: &appv1.OpenChatFrame{}}})
	}
	if f := c.read(t); f.GetError().GetCode() != appv1.FrameErrorCode_FRAME_ERROR_CODE_RATE_LIMITED {
		t.Fatalf("frame = %v, want RATE_LIMITED", f)
	}
}

func TestTypingNeedsSendPermission(t *testing.T) {
	tg := newTestGateway(t)
	tg.be.members[60] = []int64{1, 2}
	tg.be.readOnly[60] = map[int64]bool{2: true}
	writer, reader := tg.connect(t, 1), tg.connect(t, 2)
	for _, c := range []*client{writer, reader} {
		c.send(t, &appv1.ClientFrame{Frame: &appv1.ClientFrame_OpenChat{OpenChat: &appv1.OpenChatFrame{ChatId: 60}}})
	}
	time.Sleep(50 * time.Millisecond)
	reader.send(t, &appv1.ClientFrame{RequestId: 3, Frame: &appv1.ClientFrame_Typing{Typing: &appv1.TypingFrame{ChatId: 60}}})
	if f := reader.read(t); f.GetError().GetCode() != appv1.FrameErrorCode_FRAME_ERROR_CODE_FORBIDDEN || f.GetError().GetRequestId() != 3 {
		t.Fatalf("typing without send permission = %v", f)
	}
	writer.send(t, &appv1.ClientFrame{Frame: &appv1.ClientFrame_Typing{Typing: &appv1.TypingFrame{ChatId: 60}}})
	if ty := reader.read(t).GetTyping(); ty.GetUserId() != 1 {
		t.Fatalf("typing = %v", ty)
	}
}

func TestOnlineCapRefusesNewPeopleOnly(t *testing.T) {
	tg := newTestGateway(t)
	tg.hub.SetMaxOnlineUsers(1)
	tg.connect(t, 1)
	// Someone online may open another device; a new person waits.
	tg.connect(t, 1)
	if code := tg.dialHello(t, 2).closeStatus(t); code != websocket.StatusTryAgainLater {
		t.Fatalf("over the cap: close %v, want try again later", code)
	}
}

// dialNative opens a socket from the native app's iOS origin with cookie
// (when not empty) and sends hello with token.
func (tg *testGateway) dialNative(t *testing.T, token, cookie string) *client {
	t.Helper()
	h := http.Header{}
	h.Set("Origin", auth.NativeOriginIOS)
	if cookie != "" {
		h.Set("Cookie", auth.SessionCookieName+"="+cookie)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(tg.srv.URL, "http")+"/ws", &websocket.DialOptions{HTTPHeader: h})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ws.CloseNow() })
	c := &client{ws: ws}
	c.send(t, &appv1.ClientFrame{Frame: &appv1.ClientFrame_Hello{Hello: &appv1.ClientHelloFrame{SessionToken: token}}})
	return c
}

func TestNativeSocketAuthenticatesWithHelloToken(t *testing.T) {
	tg := newTestGateway(t)
	c := tg.dialNative(t, "native-4", "")
	if f := c.read(t); f.GetHello().GetUserId() != 4 || f.GetHello().GetSessionId() != 400 {
		t.Fatalf("hello = %v", f)
	}
	// A web session's cookie or token never opens a socket from a native
	// origin: the client is told it is signed out and the socket closes.
	for name, dial := range map[string]func() *client{
		"cookie only":       func() *client { return tg.dialNative(t, "", "user-5") },
		"web token":         func() *client { return tg.dialNative(t, "user-5", "") },
		"web token, cookie": func() *client { return tg.dialNative(t, "user-5", "user-5") },
	} {
		c := dial()
		if f := c.read(t); f.GetError().GetCode() != appv1.FrameErrorCode_FRAME_ERROR_CODE_UNAUTHENTICATED {
			t.Errorf("%s: first frame %v", name, f)
		}
		if st := c.closeStatus(t); st != websocket.StatusPolicyViolation {
			t.Errorf("%s: close status %v", name, st)
		}
	}
}

func TestNativeOriginsNeedNoAllowlistEntry(t *testing.T) {
	tg := newTestGateway(t)
	// The web handshake from a foreign origin is still refused before upgrade.
	h := http.Header{}
	h.Set("Origin", "capacitor://evil")
	h.Set("Cookie", auth.SessionCookieName+"=user-1")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, resp, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(tg.srv.URL, "http")+"/ws", &websocket.DialOptions{HTTPHeader: h})
	if err == nil || resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("foreign origin: resp %v err %v", resp, err)
	}
}
