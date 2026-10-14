package gateway

import (
	"context"
	"errors"
	"sync"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/ratelimit"
	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"
)

// Connection limits and timers.
const (
	// HeartbeatInterval is announced in HelloFrame; the client pings at it.
	HeartbeatInterval = 25 * time.Second
	// idleTimeout closes a socket that sent nothing for two heartbeats.
	idleTimeout  = 2*HeartbeatInterval + 5*time.Second
	helloTimeout = 10 * time.Second
	writeTimeout = 10 * time.Second
	// sendQueue bounds frames waiting for a slow client; overflow ends in
	// ResyncFrame(BACKPRESSURE) and the client catches up with GetDifference.
	sendQueue      = 256
	readLimitBytes = 64 << 10
	visibleMax     = 200
	touchEvery     = 10 * time.Minute
	closeGrace     = 500 * time.Millisecond
)

var typingRule = ratelimit.Rule{Rate: 1, Burst: 3}

type closeKind int

const (
	closeResync closeKind = iota + 1
	closeRevoked
)

// conn is one accepted WebSocket of a session.
type conn struct {
	hub       *Hub
	ws        *websocket.Conn
	userID    int64
	sessionID int64

	send chan []byte
	// ctrl carries the last frame before the server closes the socket.
	ctrl    chan []byte
	ctx     context.Context
	cancel  context.CancelFunc
	closing sync.Once
	kind    closeKind

	mu         sync.Mutex
	openChat   int64
	openLarge  bool
	visible    map[int64]bool
	foreground bool
}

func (c *conn) isForeground() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.foreground
}

func (c *conn) openChatID() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.openChat
}

// views reports whether the socket shows a large chat (open or visible in
// the dialog list), so it gets the chat's own log in realtime.
func (c *conn) views(chatID int64) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return (c.openChat == chatID && c.openLarge) || c.visible[chatID]
}

func (c *conn) forget(chatID int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.openChat == chatID {
		c.openChat, c.openLarge = 0, false
	}
	delete(c.visible, chatID)
}

// enqueue queues a frame; a full queue closes the socket with a resync.
func (c *conn) enqueue(b []byte) {
	select {
	case <-c.ctx.Done():
		return
	default:
	}
	select {
	case c.send <- b:
	default:
		resync, err := proto.Marshal(&appv1.ServerFrame{Frame: &appv1.ServerFrame_Resync{Resync: &appv1.ResyncFrame{
			Reason: appv1.ResyncReason_RESYNC_REASON_BACKPRESSURE,
		}}})
		if err == nil {
			c.closeWith(resync, closeResync)
		}
	}
}

// closeWith sends one last frame and closes the socket.
func (c *conn) closeWith(last []byte, kind closeKind) {
	c.closing.Do(func() {
		c.kind = kind
		c.ctrl <- last
	})
}

// writeLoop owns every write to the socket.
func (c *conn) writeLoop() {
	defer c.cancel()
	for {
		select {
		case <-c.ctx.Done():
			return
		case last := <-c.ctrl:
			_ = c.write(last)
			code, reason := websocket.StatusTryAgainLater, "reconnect"
			if c.kind == closeRevoked {
				code, reason = websocket.StatusPolicyViolation, "session revoked"
			}
			// A client that stops reading must not hold the socket open: the
			// close handshake gets closeGrace, then the socket is dropped.
			closed := make(chan struct{})
			go func() {
				_ = c.ws.Close(code, reason)
				close(closed)
			}()
			select {
			case <-closed:
			case <-time.After(closeGrace):
				// Returning cancels c.ctx, whose reads then close the socket.
			}
			return
		case b := <-c.send:
			if err := c.write(b); err != nil {
				return
			}
		}
	}
}

func (c *conn) write(b []byte) error {
	ctx, cancel := context.WithTimeout(c.ctx, writeTimeout)
	defer cancel()
	return c.ws.Write(ctx, websocket.MessageBinary, b)
}

func (c *conn) sendFrame(f *appv1.ServerFrame) {
	b, err := proto.Marshal(f)
	if err != nil {
		c.hub.logger.Error("encode frame failed", "err", err)
		return
	}
	c.enqueue(b)
}

func (c *conn) sendError(requestID int64, code appv1.FrameErrorCode, msg string) {
	c.sendFrame(&appv1.ServerFrame{Frame: &appv1.ServerFrame_Error{Error: &appv1.ErrorFrame{
		RequestId: requestID, Code: code, Message: msg,
	}}})
}

// readLoop handles client frames until the socket ends.
func (c *conn) readLoop(g *Gateway) error {
	for {
		ctx, cancel := context.WithTimeout(c.ctx, idleTimeout)
		typ, data, err := c.ws.Read(ctx)
		cancel()
		if err != nil {
			return err
		}
		if typ != websocket.MessageBinary {
			c.sendError(0, appv1.FrameErrorCode_FRAME_ERROR_CODE_INVALID_FRAME, "frames are binary protobuf")
			continue
		}
		f := &appv1.ClientFrame{}
		if err := proto.Unmarshal(data, f); err != nil {
			c.sendError(0, appv1.FrameErrorCode_FRAME_ERROR_CODE_INVALID_FRAME, "cannot decode frame")
			continue
		}
		switch fr := f.Frame.(type) {
		case *appv1.ClientFrame_Ping:
			c.sendFrame(&appv1.ServerFrame{Frame: &appv1.ServerFrame_Pong{Pong: &appv1.PongFrame{RequestId: f.GetRequestId()}}})
		case *appv1.ClientFrame_OpenChat:
			g.openChat(c, f.GetRequestId(), fr.OpenChat)
		case *appv1.ClientFrame_Typing:
			g.typing(c, f.GetRequestId(), fr.Typing)
		case *appv1.ClientFrame_Presence:
			c.hub.setForeground(c, fr.Presence.GetForeground())
		case *appv1.ClientFrame_Hello:
			// Already accepted; a second hello changes nothing.
		default:
			c.sendError(f.GetRequestId(), appv1.FrameErrorCode_FRAME_ERROR_CODE_INVALID_FRAME, "unknown frame")
		}
	}
}

// setForeground records a socket's foreground state and announces a change
// of the user's presence.
func (h *Hub) setForeground(c *conn, fg bool) {
	h.mu.Lock()
	was := h.onlineLocked(c.userID)
	c.mu.Lock()
	c.foreground = fg
	c.mu.Unlock()
	now := h.onlineLocked(c.userID)
	h.mu.Unlock()
	if was != now {
		h.presenceChanged(c.userID, now)
	}
}

func isNormalClose(err error) bool {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	switch websocket.CloseStatus(err) {
	case websocket.StatusNormalClosure, websocket.StatusGoingAway, websocket.StatusNoStatusRcvd:
		return true
	default:
		return false
	}
}
