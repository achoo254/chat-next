package zalo

import (
	"slices"
	"sync"
	"time"

	"app.local/server/internal/bridge"
)

// Bounds of what one account keeps in memory. The messages kept are only the
// ones a conversation Chat has not copied yet may need: the engine drops a
// message of a conversation it does not know and imports it through Backfill
// once the conversation is listed. Anything evicted before that Backfill is
// lost to Chat (no Zalo history to fetch it again).
const (
	maxHeardConversations = 200
	maxRecentPerConv      = 20
	maxHeardMessages      = 500
	maxRecentAge          = 24 * time.Hour
	maxKeptTextBytes      = 8 << 10
	maxSeenMessageIDs     = 8192
)

// heardAccount is what the listener delivered for one account in this process:
// the conversations, the messages not yet handed to Backfill, and the ids of
// messages already seen (the listener repeats messages after a reconnect).
type heardAccount struct {
	mu       sync.Mutex
	now      func() time.Time
	convs    map[string]*heardConversation
	messages int // kept in all conversations
	seen     *boundedSeenSet
}

type heardConversation struct {
	conv     bridge.Conversation
	lastSeen time.Time
	recent   []keptMessage // oldest first
	// consumed is set once Backfill handed the messages over: Chat has the
	// conversation from then on and gets its messages live.
	consumed bool
}

type keptMessage struct {
	msg   bridge.Message
	heard time.Time
}

func newHeardAccount(now func() time.Time) *heardAccount {
	return &heardAccount{now: now, convs: map[string]*heardConversation{}, seen: newBoundedSeenSet(maxSeenMessageIDs)}
}

// firstSighting records a message id and reports whether it is new.
func (h *heardAccount) firstSighting(id string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.seen.add(id)
}

// knows reports whether a conversation was heard (and not evicted since).
func (h *heardAccount) knows(conv string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.convs[conv] != nil
}

// record keeps a message and its conversation. A conversation heard only
// through the owner's own messages keeps a stand-in title until the other
// side writes and gives a name.
func (h *heardAccount) record(conv bridge.Conversation, m bridge.Message) {
	h.mu.Lock()
	defer h.mu.Unlock()
	now := h.now()
	c := h.convs[conv.ID]
	if c == nil {
		if len(h.convs) >= maxHeardConversations {
			h.evictOldestConversation()
		}
		c = &heardConversation{conv: conv}
		h.convs[conv.ID] = c
	} else if c.conv.Peer != nil && c.conv.Peer.NameUnknown && conv.Peer != nil && !conv.Peer.NameUnknown {
		c.conv = conv
	}
	c.lastSeen = now
	if c.consumed {
		return
	}
	if len(m.Text) > maxKeptTextBytes {
		m.Text = truncateUTF8(m.Text, maxKeptTextBytes)
	}
	c.recent = append(c.recent, keptMessage{msg: m, heard: now})
	h.messages++
	if len(c.recent) > maxRecentPerConv {
		c.recent = slices.Delete(c.recent, 0, 1)
		h.messages--
	}
	for h.messages > maxHeardMessages {
		h.evictOldestMessage()
	}
}

func (h *heardAccount) evictOldestConversation() {
	var oldest string
	var at time.Time
	for id, c := range h.convs {
		if oldest == "" || c.lastSeen.Before(at) {
			oldest, at = id, c.lastSeen
		}
	}
	h.messages -= len(h.convs[oldest].recent)
	delete(h.convs, oldest)
}

func (h *heardAccount) evictOldestMessage() {
	var oldest *heardConversation
	for _, c := range h.convs {
		if len(c.recent) > 0 && (oldest == nil || c.recent[0].heard.Before(oldest.recent[0].heard)) {
			oldest = c
		}
	}
	if oldest == nil {
		h.messages = 0
		return
	}
	oldest.recent = slices.Delete(oldest.recent, 0, 1)
	h.messages--
}

// conversations lists what was heard, the most recently active first. A conversation
// whose other side has no name yet is left out, so Chat never shows a bare Zalo id as
// the title: its messages stay kept, and it is listed once a message gives the name.
func (h *heardAccount) conversations() []bridge.Conversation {
	h.mu.Lock()
	defer h.mu.Unlock()
	list := make([]*heardConversation, 0, len(h.convs))
	for _, c := range h.convs {
		if c.conv.Peer != nil && c.conv.Peer.NameUnknown {
			continue
		}
		list = append(list, c)
	}
	slices.SortFunc(list, func(x, y *heardConversation) int { return y.lastSeen.Compare(x.lastSeen) })
	out := make([]bridge.Conversation, len(list))
	for i, c := range list {
		out[i] = c.conv
	}
	return out
}

// takeRecent hands over up to limit messages kept for conv, newest first, and
// forgets them all: Backfill is their only reader. Messages older than
// maxRecentAge are not handed over.
func (h *heardAccount) takeRecent(conv string, limit int) []bridge.Message {
	h.mu.Lock()
	defer h.mu.Unlock()
	c := h.convs[conv]
	if c == nil || limit <= 0 {
		return nil
	}
	cutoff := h.now().Add(-maxRecentAge)
	var out []bridge.Message
	for i := len(c.recent) - 1; i >= 0 && len(out) < limit; i-- {
		if c.recent[i].heard.After(cutoff) {
			out = append(out, c.recent[i].msg)
		}
	}
	h.messages -= len(c.recent)
	c.recent, c.consumed = nil, true
	return out
}

// truncateUTF8 cuts s to at most n bytes without splitting a character.
func truncateUTF8(s string, n int) string {
	for n > 0 && n < len(s) && s[n]&0xC0 == 0x80 {
		n--
	}
	return s[:n]
}

// boundedSeenSet remembers the last capacity ids added; the oldest goes first.
type boundedSeenSet struct {
	ids   map[string]struct{}
	order []string // ring of the ids in ids
	next  int
}

func newBoundedSeenSet(capacity int) *boundedSeenSet {
	return &boundedSeenSet{ids: make(map[string]struct{}, capacity), order: make([]string, 0, max(capacity, 1))}
}

// has reports whether id is in the set.
func (s *boundedSeenSet) has(id string) bool {
	_, ok := s.ids[id]
	return ok
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
