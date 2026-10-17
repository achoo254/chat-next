// Package gateway is the realtime WebSocket endpoint (realtime.proto). It
// runs inside the api process at /ws (stage 1, one server): the hub keeps
// the connected sessions in memory and receives rendered updates from the
// chat service right after commit, so no message bus sits in between. When
// the api scales to several processes, the hub's Sink role moves behind a
// pub/sub (Redis, then NATS) without changing the chat service.
package gateway

import (
	"context"
	"log/slog"
	"sync"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/chat"
	"google.golang.org/protobuf/proto"
)

const (
	// activityInterval coalesces chat_activity hints of large chats.
	activityInterval = time.Second
	// typingLookupTimeout bounds the database lookup of a typing frame's viewers.
	typingLookupTimeout = 2 * time.Second
	// typingCacheTTL keeps a typing audience; a member who leaves drops it at once.
	typingCacheTTL = 3 * time.Second
	// typingCacheMax bounds the cache; it is cleared when full.
	typingCacheMax = 10_000
)

// Backend is what the hub needs from the chat service.
type Backend interface {
	MemberChats(ctx context.Context, userID int64, chatIDs []int64) ([]chat.ChatAccess, error)
	MembersAmong(ctx context.Context, chatID int64, userIDs []int64) ([]int64, error)
	TypingViewers(ctx context.Context, chatID, typer int64, bot bool, viewing []int64) ([]int64, bool, error)
	PrivatePeers(ctx context.Context, userID int64) (map[int64]int64, error)
	UserStatus(ctx context.Context, viewer, userID int64, online bool) (*appv1.UserStatus, error)
	SetLastSeen(ctx context.Context, userID int64, at time.Time) error
	Epoch() int64
}

type activity struct {
	chatPts, topSeq int64
}

// Hub tracks connected sessions and fans frames out to them. It implements
// chat.Sink and chat.Presence.
type Hub struct {
	backend Backend
	logger  *slog.Logger

	mu     sync.RWMutex
	byUser map[int64]map[*conn]struct{}
	// maxUsers caps the people online (SetMaxOnlineUsers); 0: no cap.
	maxUsers  int
	bySession map[int64]map[*conn]struct{}
	closing   bool

	actMu    sync.Mutex
	activity map[int64]activity

	typingMu    sync.Mutex
	typingCache map[typingKey]typingAudience

	conns sync.WaitGroup
}

// SetMaxOnlineUsers caps the people with an open socket (0: no cap); call
// it before serving.
func (h *Hub) SetMaxOnlineUsers(n int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.maxUsers = n
}

// NewHub returns an empty hub.
func NewHub(backend Backend, logger *slog.Logger) *Hub {
	return &Hub{
		backend: backend, logger: logger,
		byUser: map[int64]map[*conn]struct{}{}, bySession: map[int64]map[*conn]struct{}{},
		activity: map[int64]activity{}, typingCache: map[typingKey]typingAudience{},
	}
}

func encodeFrame(f *appv1.ServerFrame) ([]byte, error) {
	return proto.Marshal(f)
}

// track counts a goroutine Shutdown waits for; false when shutting down.
// The count changes under h.mu, so no Add races Shutdown's Wait.
func (h *Hub) track() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closing {
		return false
	}
	h.conns.Add(1)
	return true
}

type registerResult int

const (
	registered registerResult = iota
	registerClosing
	registerTooMany
	// registerBusy: the process already has MaxOnlineUsers people online.
	registerBusy
)

// register adds a connection, unless the hub is shutting down or the
// session or user already has the most sockets allowed.
func (h *Hub) register(c *conn) registerResult {
	h.mu.Lock()
	if h.closing {
		h.mu.Unlock()
		return registerClosing
	}
	if len(h.bySession[c.sessionID]) >= maxSocketsPerSession || len(h.byUser[c.userID]) >= maxSocketsPerUser {
		h.mu.Unlock()
		return registerTooMany
	}
	// Someone already online may open another device.
	if h.maxUsers > 0 && h.byUser[c.userID] == nil && len(h.byUser) >= h.maxUsers {
		h.mu.Unlock()
		return registerBusy
	}
	wasOnline := h.onlineLocked(c.userID)
	if h.byUser[c.userID] == nil {
		h.byUser[c.userID] = map[*conn]struct{}{}
	}
	h.byUser[c.userID][c] = struct{}{}
	if h.bySession[c.sessionID] == nil {
		h.bySession[c.sessionID] = map[*conn]struct{}{}
	}
	h.bySession[c.sessionID][c] = struct{}{}
	nowOnline := h.onlineLocked(c.userID)
	h.mu.Unlock()
	if wasOnline != nowOnline {
		h.presenceChanged(c.userID, nowOnline)
	}
	return registered
}

func (h *Hub) unregister(c *conn) {
	h.mu.Lock()
	wasOnline := h.onlineLocked(c.userID)
	delete(h.byUser[c.userID], c)
	if len(h.byUser[c.userID]) == 0 {
		delete(h.byUser, c.userID)
	}
	delete(h.bySession[c.sessionID], c)
	if len(h.bySession[c.sessionID]) == 0 {
		delete(h.bySession, c.sessionID)
	}
	nowOnline := h.onlineLocked(c.userID)
	h.mu.Unlock()
	if wasOnline && !nowOnline {
		h.presenceChanged(c.userID, false)
	}
}

func (h *Hub) onlineLocked(userID int64) bool {
	for c := range h.byUser[userID] {
		if c.isForeground() {
			return true
		}
	}
	return false
}

// Online implements chat.Presence.
func (h *Hub) Online(userID int64) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.onlineLocked(userID)
}

// OnlineUsers implements chat.Presence: every user with a foreground
// socket.
func (h *Hub) OnlineUsers() []int64 {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]int64, 0, len(h.byUser))
	for u := range h.byUser {
		if h.onlineLocked(u) {
			out = append(out, u)
		}
	}
	return out
}

// connsOf returns a snapshot of the user's connections.
func (h *Hub) connsOf(userID int64) []*conn {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]*conn, 0, len(h.byUser[userID]))
	for c := range h.byUser[userID] {
		out = append(out, c)
	}
	return out
}

func (h *Hub) all() []*conn {
	h.mu.RLock()
	defer h.mu.RUnlock()
	var out []*conn
	for _, set := range h.byUser {
		for c := range set {
			out = append(out, c)
		}
	}
	return out
}

// SendUser implements chat.Sink.
func (h *Hub) SendUser(userID int64, frame *appv1.ServerFrame) {
	conns := h.connsOf(userID)
	if len(conns) == 0 {
		return
	}
	b, err := encodeFrame(frame)
	if err != nil {
		h.logger.Error("encode frame failed", "err", err)
		return
	}
	for _, c := range conns {
		c.enqueue(b)
	}
}

// ChatViewers implements chat.Sink.
func (h *Hub) ChatViewers(chatID int64) []int64 {
	h.mu.RLock()
	defer h.mu.RUnlock()
	var out []int64
	for user, set := range h.byUser {
		for c := range set {
			if c.views(chatID) {
				out = append(out, user)
				break
			}
		}
	}
	return out
}

// SendChatViewer implements chat.Sink.
func (h *Hub) SendChatViewer(userID, chatID int64, frame *appv1.ServerFrame) {
	var targets []*conn
	for _, c := range h.connsOf(userID) {
		if c.views(chatID) {
			targets = append(targets, c)
		}
	}
	if len(targets) == 0 {
		return
	}
	b, err := encodeFrame(frame)
	if err != nil {
		h.logger.Error("encode frame failed", "err", err)
		return
	}
	for _, c := range targets {
		c.enqueue(b)
	}
}

// ChatActivity implements chat.Sink: hints are coalesced and sent by
// RunActivity.
func (h *Hub) ChatActivity(chatID, chatPts, topSeq int64) {
	h.actMu.Lock()
	defer h.actMu.Unlock()
	cur := h.activity[chatID]
	h.activity[chatID] = activity{chatPts: max(cur.chatPts, chatPts), topSeq: max(cur.topSeq, topSeq)}
}

// RunActivity sends coalesced chat_activity hints to online members of
// large chats who do not have the chat open or visible, until ctx ends.
func (h *Hub) RunActivity(ctx context.Context) {
	ticker := time.NewTicker(activityInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			h.flushActivity(ctx)
		}
	}
}

func (h *Hub) flushActivity(ctx context.Context) {
	h.actMu.Lock()
	pending := h.activity
	h.activity = map[int64]activity{}
	h.actMu.Unlock()
	if len(pending) == 0 {
		return
	}
	h.mu.RLock()
	online := make([]int64, 0, len(h.byUser))
	for u := range h.byUser {
		online = append(online, u)
	}
	h.mu.RUnlock()
	epoch := h.backend.Epoch()
	for chatID, a := range pending {
		members, err := h.backend.MembersAmong(ctx, chatID, online)
		if err != nil {
			h.logger.Warn("chat activity: members lookup failed", "chat_id", chatID, "err", err)
			continue
		}
		b, err := encodeFrame(&appv1.ServerFrame{Frame: &appv1.ServerFrame_Update{Update: &appv1.UpdateFrame{
			Updates: []*appv1.Update{{ChatId: chatID, ServerEpoch: epoch, Date: time.Now().Unix(),
				Kind: &appv1.Update_ChatActivity{ChatActivity: &appv1.UpdateChatActivity{ChatId: chatID, ChatPts: a.chatPts, TopSeq: a.topSeq}}}},
		}}})
		if err != nil {
			continue
		}
		for _, u := range members {
			for _, c := range h.connsOf(u) {
				if !c.views(chatID) {
					c.enqueue(b)
				}
			}
		}
	}
}

// RevokeSession implements chat.Sink.
func (h *Hub) RevokeSession(sessionID int64, reason appv1.SessionRevokeReason) {
	h.mu.RLock()
	var targets []*conn
	for c := range h.bySession[sessionID] {
		targets = append(targets, c)
	}
	h.mu.RUnlock()
	if len(targets) == 0 {
		return
	}
	b, err := encodeFrame(&appv1.ServerFrame{Frame: &appv1.ServerFrame_SessionRevoked{SessionRevoked: &appv1.SessionRevokedFrame{Reason: reason}}})
	if err != nil {
		return
	}
	for _, c := range targets {
		c.closeWith(b, closeRevoked)
	}
}

// ForgetChat implements chat.Sink.
func (h *Hub) ForgetChat(userID, chatID int64) {
	h.forgetTyping(chatID)
	for _, c := range h.connsOf(userID) {
		c.forget(chatID)
	}
}

// ResyncAll implements chat.Sink.
func (h *Hub) ResyncAll(reason appv1.ResyncReason) {
	b, err := encodeFrame(&appv1.ServerFrame{Frame: &appv1.ServerFrame_Resync{Resync: &appv1.ResyncFrame{Reason: reason}}})
	if err != nil {
		return
	}
	for _, c := range h.all() {
		c.closeWith(b, closeResync)
	}
}

// Shutdown refuses new connections, asks every client to reconnect and
// waits (bounded by ctx) for the connections to end.
func (h *Hub) Shutdown(ctx context.Context) {
	h.mu.Lock()
	h.closing = true
	h.mu.Unlock()
	h.ResyncAll(appv1.ResyncReason_RESYNC_REASON_SERVER_RESTART)
	done := make(chan struct{})
	go func() {
		h.conns.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-ctx.Done():
	}
}

// Connected returns how many sockets are open.
func (h *Hub) Connected() int {
	return len(h.all())
}

// presenceChanged tells the user's private chat peers that have the chat
// open, with each peer's view of the status, and records last seen when
// the user goes offline.
func (h *Hub) presenceChanged(userID int64, online bool) {
	if !h.track() {
		return
	}
	go func() {
		defer h.conns.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if !online {
			if err := h.backend.SetLastSeen(ctx, userID, time.Now()); err != nil {
				h.logger.Warn("record last seen failed", "user_id", userID, "err", err)
			}
		}
		peers, err := h.backend.PrivatePeers(ctx, userID)
		if err != nil {
			h.logger.Warn("presence: peers lookup failed", "user_id", userID, "err", err)
			return
		}
		for chatID, peer := range peers {
			var targets []*conn
			for _, c := range h.connsOf(peer) {
				if c.openChatID() == chatID {
					targets = append(targets, c)
				}
			}
			if len(targets) == 0 {
				continue
			}
			status, err := h.backend.UserStatus(ctx, peer, userID, online)
			if err != nil {
				h.logger.Warn("presence: status failed", "user_id", userID, "err", err)
				continue
			}
			b, err := encodeFrame(&appv1.ServerFrame{Frame: &appv1.ServerFrame_Presence{Presence: &appv1.PresenceFrame{UserId: userID, Status: status}}})
			if err != nil {
				continue
			}
			for _, c := range targets {
				c.enqueue(b)
			}
		}
	}()
}

// typing forwards a person's typing frame (see typingFrom).
func (h *Hub) typing(from *conn, chatID int64, b []byte) {
	h.typingFrom(from.ctx, from.userID, chatID, false, b)
}

// BotTyping relays a bot's chat action (Bot API POST /chats/{id}/actions,
// already checked: the bot may post there) as a typing frame of the bot.
// Clients drop it after about 5 seconds unless it comes again.
func (h *Hub) BotTyping(botID, chatID, topicID int64, action appv1.TypingAction) {
	b, err := encodeFrame(&appv1.ServerFrame{Frame: &appv1.ServerFrame_Typing{Typing: &appv1.TypingFrame{
		ChatId: chatID, UserId: botID, Action: action, TopicId: topicID,
	}}})
	if err != nil {
		return
	}
	h.typingFrom(context.Background(), botID, chatID, true, b)
}

type typingKey struct{ chatID, typer int64 }

// typingAudience is who sees one person's typing in one chat, kept for
// typingCacheTTL so typing every few seconds costs one lookup.
type typingAudience struct {
	viewers []int64
	large   bool
	until   time.Time
}

// typingFrom sends a typing frame to the connected members allowed to see
// it (Backend.TypingViewers): in a large chat the sockets that have it open
// or in their list, in other chats every socket, so the dialog list shows it.
func (h *Hub) typingFrom(ctx context.Context, userID, chatID int64, bot bool, b []byte) {
	key := typingKey{chatID, userID}
	h.typingMu.Lock()
	audience, cached := h.typingCache[key]
	h.typingMu.Unlock()
	if !cached || time.Now().After(audience.until) {
		h.mu.RLock()
		var viewing []int64
		for user, set := range h.byUser {
			if user == userID {
				continue
			}
			for c := range set {
				if c.openChatID() == chatID || c.views(chatID) {
					viewing = append(viewing, user)
					break
				}
			}
		}
		h.mu.RUnlock()
		ctx, cancel := context.WithTimeout(ctx, typingLookupTimeout)
		defer cancel()
		viewers, large, err := h.backend.TypingViewers(ctx, chatID, userID, bot, viewing)
		if err != nil {
			h.logger.Warn("typing: viewers lookup failed", "chat_id", chatID, "err", err)
			return
		}
		audience = typingAudience{viewers: viewers, large: large, until: time.Now().Add(typingCacheTTL)}
		h.typingMu.Lock()
		if len(h.typingCache) >= typingCacheMax {
			clear(h.typingCache)
		}
		h.typingCache[key] = audience
		h.typingMu.Unlock()
	}
	for _, u := range audience.viewers {
		for _, c := range h.connsOf(u) {
			if !audience.large || c.openChatID() == chatID || c.views(chatID) {
				c.enqueue(b)
			}
		}
	}
}

// forgetTyping drops the cached typing audiences of a chat (a member left).
func (h *Hub) forgetTyping(chatID int64) {
	h.typingMu.Lock()
	defer h.typingMu.Unlock()
	for key := range h.typingCache {
		if key.chatID == chatID {
			delete(h.typingCache, key)
		}
	}
}
