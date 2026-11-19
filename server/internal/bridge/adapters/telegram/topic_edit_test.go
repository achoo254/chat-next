package telegram

import (
	"testing"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/tg"
)

func TestATopicEditSendsTheClosedStateInACallOfItsOwn(t *testing.T) {
	title, closed := "Hạ tầng", false
	reqs := topicEditRequests(&tg.InputPeerSelf{}, 7, bridge.TopicEdit{Title: &title, Closed: &closed})
	if len(reqs) != 2 {
		t.Fatalf("%d calls, want 2", len(reqs))
	}
	if got, ok := reqs[0].GetTitle(); !ok || got != title {
		t.Fatalf("first call title = %q, %v", got, ok)
	}
	if _, ok := reqs[0].GetClosed(); ok {
		t.Fatal("the closed flag went with the title")
	}
	if got, ok := reqs[1].GetClosed(); !ok || got != closed {
		t.Fatalf("second call closed = %v, %v", got, ok)
	}
	if _, ok := reqs[1].GetTitle(); ok {
		t.Fatal("the title went with the closed flag")
	}
	if n := len(topicEditRequests(&tg.InputPeerSelf{}, 7, bridge.TopicEdit{Title: &title})); n != 1 {
		t.Fatalf("a rename alone makes %d calls", n)
	}
}
