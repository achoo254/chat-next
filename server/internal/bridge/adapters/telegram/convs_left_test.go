package telegram

import (
	"testing"

	"github.com/gotd/td/tg"

	"app.local/server/internal/bridge"
)

func TestABasicGroupTheAccountLeftIsNotAConversation(t *testing.T) {
	b := newPeerBook()
	b.chats[1] = &tg.Chat{ID: 1, Title: "still in"}
	b.chats[2] = &tg.Chat{ID: 2, Title: "left", Left: true}
	b.chats[3] = &tg.Chat{ID: 3, Title: "upgraded", Deactivated: true}

	conv, ok := b.conversationOf(&tg.PeerChat{ChatID: 1}, selfID)
	if !ok || conv.Kind != bridge.ConvGroup || conv.Title != "still in" {
		t.Fatalf("a group the account is in = %+v (ok %v), want a group titled %q", conv, ok, "still in")
	}
	for _, id := range []int64{2, 3, 4} {
		if conv, ok := b.conversationOf(&tg.PeerChat{ChatID: id}, selfID); ok {
			t.Errorf("chat %d is a conversation (%+v), want it left out: left, upgraded or unknown", id, conv)
		}
	}
}
