package zalo

import (
	"strconv"
	"strings"
	"testing"
	"time"

	"app.local/server/internal/bridge"
)

func heardMessage(conv string, n int) (bridge.Conversation, bridge.Message) {
	peer := bridge.Participant{ID: conv, Name: "P"}
	return bridge.Conversation{ID: conv, Kind: bridge.ConvPrivate, Title: "P", Peer: &peer},
		bridge.Message{Conversation: conv, ID: conv + "-" + strconv.Itoa(n), From: peer, Text: "t"}
}

func TestHeardKeepsFewMessagesPerConversation(t *testing.T) {
	clock := newFakeClock()
	h := newHeardAccount(clock.now)
	for i := 0; i < maxRecentPerConv+5; i++ {
		h.record(heardMessage("a", i))
		clock.advance(time.Second)
	}
	got := h.takeRecent("a", 1000)
	if len(got) != maxRecentPerConv || got[0].ID != "a-"+strconv.Itoa(maxRecentPerConv+4) {
		t.Fatalf("kept %d, newest %q", len(got), got[0].ID)
	}
}

func TestHeardEvictsTheOldestMessagesOverTheTotal(t *testing.T) {
	clock := newFakeClock()
	h := newHeardAccount(clock.now)
	convs := maxHeardMessages/maxRecentPerConv + 5
	for c := 0; c < convs; c++ {
		for i := 0; i < maxRecentPerConv; i++ {
			h.record(heardMessage("c"+strconv.Itoa(c), i))
			clock.advance(time.Second)
		}
	}
	if h.messages != maxHeardMessages {
		t.Fatalf("kept %d messages, want %d", h.messages, maxHeardMessages)
	}
	if got := h.takeRecent("c0", 1000); len(got) != 0 {
		t.Errorf("the oldest conversation still has %d messages", len(got))
	}
	if got := h.takeRecent("c"+strconv.Itoa(convs-1), 1000); len(got) != maxRecentPerConv {
		t.Errorf("the newest conversation has %d messages", len(got))
	}
	if h.messages != maxHeardMessages-maxRecentPerConv {
		t.Errorf("count after a take = %d", h.messages)
	}
}

func TestHeardHandsMessagesOverOnceAndThenKeepsNone(t *testing.T) {
	clock := newFakeClock()
	h := newHeardAccount(clock.now)
	h.record(heardMessage("a", 1))
	if got := h.takeRecent("a", 10); len(got) != 1 {
		t.Fatalf("first take = %d", len(got))
	}
	h.record(heardMessage("a", 2)) // Chat has the conversation now: it comes live
	if got := h.takeRecent("a", 10); len(got) != 0 || h.messages != 0 {
		t.Errorf("after the take: %d handed, %d kept", len(got), h.messages)
	}
	if convs := h.conversations(); len(convs) != 1 {
		t.Errorf("the conversation is still listed: %d", len(convs))
	}
}

func TestHeardDropsOldMessagesAndLongText(t *testing.T) {
	clock := newFakeClock()
	h := newHeardAccount(clock.now)
	h.record(heardMessage("a", 1))
	clock.advance(maxRecentAge + time.Minute)
	conv, m := heardMessage("a", 2)
	m.Text = strings.Repeat("ạ", maxKeptTextBytes) // 3 bytes each
	h.record(conv, m)
	got := h.takeRecent("a", 10)
	if len(got) != 1 || got[0].ID != "a-2" {
		t.Fatalf("handed %+v, want only the recent one", got)
	}
	if len(got[0].Text) > maxKeptTextBytes || !strings.HasPrefix(m.Text, got[0].Text) {
		t.Errorf("kept %d bytes, or cut inside a character", len(got[0].Text))
	}
}

func TestHeardBoundsConversations(t *testing.T) {
	clock := newFakeClock()
	h := newHeardAccount(clock.now)
	for c := 0; c < maxHeardConversations+10; c++ {
		h.record(heardMessage("c"+strconv.Itoa(c), 0))
		clock.advance(time.Second)
	}
	if n := len(h.conversations()); n != maxHeardConversations {
		t.Errorf("conversations = %d", n)
	}
	if h.messages > maxHeardMessages {
		t.Errorf("messages = %d", h.messages)
	}
}
