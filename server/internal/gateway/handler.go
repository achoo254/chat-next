package gateway

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/auth"
	"app.local/server/internal/ratelimit"
	"app.local/server/internal/store"
	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"
)

// Sessions authenticates the session cookie of the handshake, or the
// session token a native app sends in its ClientHelloFrame (native sessions
// only).
type Sessions interface {
	Authenticate(ctx context.Context, token string) (store.Session, error)
	AuthenticateBearer(ctx context.Context, token string) (store.Session, error)
}

// Toucher records activity of a long-lived session and reports whether it
// is still active.
type Toucher interface {
	TouchSession(ctx context.Context, id int64, minInterval time.Duration) (store.SessionStatus, error)
}

// Config wires the gateway.
type Config struct {
	Hub      *Hub
	Sessions Sessions
	Toucher  Toucher
	Origins  *auth.Origins
	Logger   *slog.Logger
	// SessionCheckInterval is how often an open socket re-checks its
	// session in the database (a safety net behind the outbox's
	// session_revoked); zero is sessionCheckEvery.
	SessionCheckInterval time.Duration
}

// Gateway serves the /ws endpoint.
type Gateway struct {
	hub        *Hub
	sessions   Sessions
	toucher    Toucher
	origins    *auth.Origins
	logger     *slog.Logger
	limiter    *ratelimit.Memory
	checkEvery time.Duration
}

// New returns the /ws handler.
func New(cfg Config) (*Gateway, error) {
	if cfg.Hub == nil || cfg.Sessions == nil || cfg.Toucher == nil || cfg.Origins == nil || cfg.Logger == nil {
		return nil, errors.New("gateway: missing dependency")
	}
	checkEvery := cfg.SessionCheckInterval
	if checkEvery <= 0 {
		checkEvery = sessionCheckEvery
	}
	return &Gateway{hub: cfg.Hub, sessions: cfg.Sessions, toucher: cfg.Toucher, origins: cfg.Origins,
		logger: cfg.Logger, limiter: ratelimit.NewMemory(), checkEvery: checkEvery}, nil
}

// revokedFrame encodes SessionRevokedFrame for a session status that is no
// longer active.
func revokedFrame(st store.SessionStatus) ([]byte, error) {
	reason := appv1.SessionRevokeReason(st.RevokeReason)
	if reason == appv1.SessionRevokeReason_SESSION_REVOKE_REASON_UNSPECIFIED {
		reason = appv1.SessionRevokeReason_SESSION_REVOKE_REASON_EXPIRED
	}
	return proto.Marshal(&appv1.ServerFrame{Frame: &appv1.ServerFrame_SessionRevoked{SessionRevoked: &appv1.SessionRevokedFrame{
		Reason: reason,
	}}})
}

// ServeHTTP authenticates the handshake (Origin allowlist and the session
// cookie, ADR 0006) before upgrading, so a cross-site page can never open a
// socket on the user's session. Failures answer 403 or 401 without an
// upgrade; the client then asks an RPC which one it was.
//
// The native app's WebView cannot set headers on a WebSocket and holds no
// cookie: from its origins the socket is upgraded first and authenticated
// by the session token of the ClientHelloFrame (a native session only); the
// cookie is never looked at. A cross-site page cannot know that token.
func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if g.origins.Native(origin) {
		ws, ok := g.accept(w, r)
		if ok {
			g.serve(ws, nil)
		}
		return
	}
	if !g.origins.Allowed(origin) {
		http.Error(w, "origin not allowed", http.StatusForbidden)
		return
	}
	token := auth.SessionToken(r.Header)
	if token == "" {
		http.Error(w, "sign-in required", http.StatusUnauthorized)
		return
	}
	sess, err := g.sessions.Authenticate(r.Context(), token)
	if errors.Is(err, auth.ErrNoSession) {
		http.Error(w, "sign-in required", http.StatusUnauthorized)
		return
	}
	if err != nil {
		g.logger.Error("websocket authentication failed", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if sess.AccountLocked {
		// Waiting for deletion: no realtime until the user cancels it.
		http.Error(w, "account pending deletion", http.StatusForbidden)
		return
	}
	ws, ok := g.accept(w, r)
	if !ok {
		return
	}
	g.serve(ws, &sess)
}

// accept upgrades a request whose Origin was checked by the caller.
func (g *Gateway) accept(w http.ResponseWriter, r *http.Request) (*websocket.Conn, bool) {
	// The api server's read/write timeouts must not cut a long-lived socket.
	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(time.Time{})
	_ = rc.SetWriteDeadline(time.Time{})
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Origin was checked by the caller against the exact allowlist.
		InsecureSkipVerify: true,
	})
	if err != nil {
		return nil, false
	}
	ws.SetReadLimit(readLimitBytes)
	return ws, true
}

// serve runs an upgraded socket. sess is the session the cookie of the
// handshake authenticated, or nil for a native app's socket, which is
// authenticated by the session token of its ClientHelloFrame.
func (g *Gateway) serve(ws *websocket.Conn, cookieSession *store.Session) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var sessionID int64
	if cookieSession != nil {
		sessionID = cookieSession.ID
	}
	// The client speaks first: ClientHelloFrame.
	hctx, hcancel := context.WithTimeout(ctx, helloTimeout)
	typ, data, err := ws.Read(hctx)
	hcancel()
	if err != nil {
		if !isNormalClose(err) {
			g.logger.Warn("websocket closed before hello", "session_id", sessionID, "err", err)
		}
		_ = ws.Close(websocket.StatusPolicyViolation, "hello expected")
		return
	}
	f := &appv1.ClientFrame{}
	if typ != websocket.MessageBinary || proto.Unmarshal(data, f) != nil || f.GetHello() == nil {
		g.logger.Warn("websocket first frame is not a hello", "session_id", sessionID, "binary", typ == websocket.MessageBinary, "bytes", len(data))
		_ = ws.Close(websocket.StatusPolicyViolation, "hello expected")
		return
	}
	sess, ok := g.helloSession(ctx, ws, cookieSession, f.GetHello())
	if !ok {
		return
	}
	c := &conn{
		hub: g.hub, ws: ws, userID: sess.UserID, sessionID: sess.ID,
		send: make(chan []byte, sendQueue), ctrl: make(chan []byte, 1),
		ctx: ctx, cancel: cancel, visible: map[int64]bool{}, foreground: true,
	}
	if !g.hub.track() {
		_ = ws.Close(websocket.StatusTryAgainLater, "server restarting")
		return
	}
	defer g.hub.conns.Done()
	// Registered before Hello: every update committed after the client hears
	// Hello reaches this socket, and GetDifference covers everything before.
	switch g.hub.register(c) {
	case registerClosing:
		_ = ws.Close(websocket.StatusTryAgainLater, "server restarting")
		return
	case registerBusy:
		// The client keeps "connecting" and retries with backoff.
		g.logger.Info("websocket refused: online cap reached", "user_id", sess.UserID)
		_ = ws.Close(websocket.StatusTryAgainLater, "server busy")
		return
	case registerTooMany:
		g.logger.Warn("websocket refused: too many connections", "session_id", sess.ID, "user_id", sess.UserID)
		_ = ws.Close(websocket.StatusPolicyViolation, "too many connections")
		return
	default:
	}
	defer g.hub.unregister(c)
	// A revocation committed between the handshake's check and register was
	// sent to the session's sockets before this one existed: check again.
	sctx, scancel := context.WithTimeout(ctx, 5*time.Second)
	st, err := g.toucher.TouchSession(sctx, sess.ID, time.Minute)
	scancel()
	if err != nil {
		g.logger.Error("websocket session check failed", "session_id", sess.ID, "err", err)
		_ = ws.Close(websocket.StatusTryAgainLater, "try again")
		return
	}
	if !st.Active {
		if b, err := revokedFrame(st); err == nil {
			wctx, wcancel := context.WithTimeout(ctx, writeTimeout)
			_ = ws.Write(wctx, websocket.MessageBinary, b)
			wcancel()
		}
		_ = ws.Close(websocket.StatusPolicyViolation, "session revoked")
		return
	}
	c.sendFrame(&appv1.ServerFrame{Frame: &appv1.ServerFrame_Hello{Hello: &appv1.HelloFrame{
		UserId: sess.UserID, SessionId: sess.ID, ServerEpoch: g.hub.backend.Epoch(),
		HeartbeatIntervalMs: int32(HeartbeatInterval / time.Millisecond), ServerTime: time.Now().Unix(),
	}}})
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		c.writeLoop()
	}()
	go g.keepSession(c, sess)
	err = c.readLoop(g)
	if err != nil && !isNormalClose(err) {
		g.logger.Debug("websocket closed", "session_id", sess.ID, "err", err)
	}
	cancel()
	<-writerDone
	_ = ws.CloseNow()
}

// helloSession returns the socket's session: the cookie's, or for a native
// socket the native session of the hello's token. A native socket without a
// valid token gets an UNAUTHENTICATED error frame (the client then ends its
// local session) and is closed; one of an account waiting for deletion is
// closed like the web handshake refuses it.
func (g *Gateway) helloSession(ctx context.Context, ws *websocket.Conn, cookieSession *store.Session, hello *appv1.ClientHelloFrame) (store.Session, bool) {
	if cookieSession != nil {
		return *cookieSession, true
	}
	actx, acancel := context.WithTimeout(ctx, 5*time.Second)
	sess, err := g.sessions.AuthenticateBearer(actx, hello.GetSessionToken())
	acancel()
	switch {
	case errors.Is(err, auth.ErrNoSession):
		if b, merr := proto.Marshal(&appv1.ServerFrame{Frame: &appv1.ServerFrame_Error{Error: &appv1.ErrorFrame{
			Code: appv1.FrameErrorCode_FRAME_ERROR_CODE_UNAUTHENTICATED, Message: "sign-in required",
		}}}); merr == nil {
			wctx, wcancel := context.WithTimeout(ctx, writeTimeout)
			_ = ws.Write(wctx, websocket.MessageBinary, b)
			wcancel()
		}
		_ = ws.Close(websocket.StatusPolicyViolation, "sign-in required")
		return store.Session{}, false
	case err != nil:
		g.logger.Error("websocket authentication failed", "err", err)
		_ = ws.Close(websocket.StatusTryAgainLater, "try again")
		return store.Session{}, false
	case sess.AccountLocked:
		// Waiting for deletion: no realtime until the user cancels it.
		_ = ws.Close(websocket.StatusPolicyViolation, "account pending deletion")
		return store.Session{}, false
	}
	return sess, true
}

// keepSession marks the session active while the socket lives, re-checks
// it every checkEvery (closing the socket once it is revoked or expired)
// and closes the socket when a web session reaches its maximum age (native
// sessions have none).
func (g *Gateway) keepSession(c *conn, sess store.Session) {
	expiry := time.NewTimer(time.Until(sess.CreatedAt.Add(store.SessionMaxAge)))
	defer expiry.Stop()
	if sess.Native() {
		expiry.Stop()
	}
	check := time.NewTicker(g.checkEvery)
	defer check.Stop()
	for {
		select {
		case <-c.ctx.Done():
			return
		case <-expiry.C:
			if b, err := revokedFrame(store.SessionStatus{}); err == nil {
				c.closeWith(b, closeRevoked)
			}
			return
		case <-check.C:
			ctx, cancel := context.WithTimeout(c.ctx, 5*time.Second)
			st, err := g.toucher.TouchSession(ctx, sess.ID, touchEvery)
			failed := err != nil && ctx.Err() == nil
			cancel()
			if failed {
				g.logger.Warn("session check failed", "session_id", sess.ID, "err", err)
				continue
			}
			if err == nil && !st.Active {
				if b, err := revokedFrame(st); err == nil {
					c.closeWith(b, closeRevoked)
				}
				return
			}
		}
	}
}

// openChat validates the open chat and the visible large chats against
// membership (ADR 0006: no typing, presence or large fan-out otherwise).
func (g *Gateway) openChat(c *conn, requestID int64, f *appv1.OpenChatFrame) {
	// Each frame costs a database lookup.
	if !g.limiter.Allow(openChatRule, fmt.Sprintf("open:%d", c.sessionID)) {
		c.sendError(requestID, appv1.FrameErrorCode_FRAME_ERROR_CODE_RATE_LIMITED, "too many open chat frames")
		return
	}
	visible := f.GetVisibleChatIds()
	if len(visible) > visibleMax {
		visible = visible[:visibleMax]
	}
	ids := append([]int64{}, visible...)
	if f.GetChatId() != 0 {
		ids = append(ids, f.GetChatId())
	}
	ctx, cancel := context.WithTimeout(c.ctx, 5*time.Second)
	defer cancel()
	access, err := g.hub.backend.MemberChats(ctx, c.userID, ids)
	if err != nil {
		g.logger.Warn("open chat: membership lookup failed", "err", err)
		return
	}
	var openLarge, member, mayType bool
	var peer int64
	vis := map[int64]bool{}
	for _, a := range access {
		if a.ChatID == f.GetChatId() {
			member, openLarge, peer = true, a.Large, a.PeerID
			mayType = a.CanSend && !a.Blocked
		}
		if a.Large {
			for _, v := range visible {
				if v == a.ChatID {
					vis[a.ChatID] = true
				}
			}
		}
	}
	c.mu.Lock()
	c.visible = vis
	if member {
		c.openChat, c.openLarge, c.mayType = f.GetChatId(), openLarge, mayType
	} else {
		c.openChat, c.openLarge, c.mayType = 0, false, false
	}
	c.mu.Unlock()
	if f.GetChatId() != 0 && !member {
		c.sendError(requestID, appv1.FrameErrorCode_FRAME_ERROR_CODE_FORBIDDEN, "not a member of this chat")
		return
	}
	if peer != 0 {
		status, err := g.hub.backend.UserStatus(ctx, c.userID, peer, g.hub.Online(peer))
		if err != nil {
			g.logger.Warn("open chat: peer status failed", "err", err)
			return
		}
		c.sendFrame(&appv1.ServerFrame{Frame: &appv1.ServerFrame_Presence{Presence: &appv1.PresenceFrame{UserId: peer, Status: status}}})
	}
}

// typing relays a typing frame of the open chat to others viewing it.
func (g *Gateway) typing(c *conn, requestID int64, f *appv1.TypingFrame) {
	chatID := f.GetChatId()
	open, mayType := c.openChatAccess()
	if chatID == 0 || chatID != open {
		c.sendError(requestID, appv1.FrameErrorCode_FRAME_ERROR_CODE_FORBIDDEN, "typing is only sent for the open chat")
		return
	}
	// Only someone who may post types; never across a block.
	if !mayType {
		c.sendError(requestID, appv1.FrameErrorCode_FRAME_ERROR_CODE_FORBIDDEN, "you cannot send messages in this chat")
		return
	}
	if !g.limiter.Allow(typingRule, fmt.Sprintf("%d:%d", c.sessionID, chatID)) {
		return
	}
	b, err := proto.Marshal(&appv1.ServerFrame{Frame: &appv1.ServerFrame_Typing{Typing: &appv1.TypingFrame{
		ChatId: chatID, UserId: c.userID, Action: f.GetAction(), TopicId: f.GetTopicId(),
	}}})
	if err != nil {
		return
	}
	g.hub.typing(c, chatID, b)
}

// RunSweeps drops idle rate limit buckets until ctx ends.
func (g *Gateway) RunSweeps(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			g.limiter.Sweep(time.Minute)
		}
	}
}
