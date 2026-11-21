package zalo

import (
	"slices"
	"sync"
	"time"

	"app.local/server/internal/bridge"
)

// Bounds of what one account remembers in memory.
const (
	maxHeardConversations = 2000
	maxRecentPerConv      = 200
	maxSeenMessageIDs     = 8192
)

// heardAccount is what the sidecar's listener delivered for one account in
// this process: the conversations, the latest messages of each (Backfill of a
// conversation Chat has not copied yet), and the message ids already seen (the
// listener repeats messages after a reconnect).
type heardAccount struct {
	mu    sync.Mutex
	convs map[string]*heardConversation
	seen  *boundedSeenSet
}

type heardConversation struct {
	conv     bridge.Conversation
	lastSeen time.Time
	recent   []bridge.Message // oldest first, at most maxRecentPerConv
}

func newHeardAccount() *heardAccount {
	return &heardAccount{convs: map[string]*heardConversation{}, seen: newBoundedSeenSet(maxSeenMessageIDs)}
}

// firstSighting records a message id and reports whether it is new.
func (h *heardAccount) firstSighting(id string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.seen.add(id)
}

// record keeps a message and its conversation. A conversation heard only
// through the owner's own messages keeps a stand-in title until the other
// side writes and gives a name.
func (h *heardAccount) record(conv bridge.Conversation, m bridge.Message) {
	h.mu.Lock()
	defer h.mu.Unlock()
	c := h.convs[conv.ID]
	if c == nil {
		if len(h.convs) >= maxHeardConversations {
			h.evictOldest()
		}
		c = &heardConversation{conv: conv}
		h.convs[conv.ID] = c
	} else if c.conv.Peer != nil && c.conv.Peer.NameUnknown && conv.Peer != nil && !conv.Peer.NameUnknown {
		c.conv = conv
	}
	c.lastSeen = time.Now()
	c.recent = append(c.recent, m)
	if over := len(c.recent) - maxRecentPerConv; over > 0 {
		c.recent = slices.Delete(c.recent, 0, over)
	}
}

func (h *heardAccount) evictOldest() {
	var oldest string
	var at time.Time
	for id, c := range h.convs {
		if oldest == "" || c.lastSeen.Before(at) {
			oldest, at = id, c.lastSeen
		}
	}
	delete(h.convs, oldest)
}

// conversations lists what was heard, the most recently active first.
func (h *heardAccount) conversations() []bridge.Conversation {
	h.mu.Lock()
	defer h.mu.Unlock()
	list := make([]*heardConversation, 0, len(h.convs))
	for _, c := range h.convs {
		list = append(list, c)
	}
	slices.SortFunc(list, func(x, y *heardConversation) int { return y.lastSeen.Compare(x.lastSeen) })
	out := make([]bridge.Conversation, len(list))
	for i, c := range list {
		out[i] = c.conv
	}
	return out
}

// recent returns up to limit messages heard in conv, newest first.
func (h *heardAccount) recent(conv string, limit int) []bridge.Message {
	h.mu.Lock()
	defer h.mu.Unlock()
	c := h.convs[conv]
	if c == nil || limit <= 0 {
		return nil
	}
	n := min(limit, len(c.recent))
	out := make([]bridge.Message, 0, n)
	for i := len(c.recent) - 1; i >= len(c.recent)-n; i-- {
		out = append(out, c.recent[i])
	}
	return out
}

// boundedSeenSet remembers the last capacity ids added; the oldest goes first.
type boundedSeenSet struct {
	ids   map[string]struct{}
	order []string // ring of the ids in ids
	next  int
}

func newBoundedSeenSet(capacity int) *boundedSeenSet {
	return &boundedSeenSet{ids: make(map[string]struct{}, capacity), order: make([]string, 0, capacity)}
}

// add reports whether id was not in the set, and adds it.
func (s *boundedSeenSet) add(id string) bool {
	if _, ok := s.ids[id]; ok {
		return false
	}
	if len(s.order) < cap(s.order) {
		s.order = append(s.order, id)
	} else {
		delete(s.ids, s.order[s.next])
		s.order[s.next] = id
		s.next = (s.next + 1) % len(s.order)
	}
	s.ids[id] = struct{}{}
	return true
}
