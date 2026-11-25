package engine

import (
	"testing"
	"time"

	"app.local/server/internal/bridge"
)

func TestSeenOf(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	if _, ok := seenOf(bridge.Participant{}, now); ok {
		t.Fatal("a participant without a stated time has none")
	}
	if _, ok := seenOf(bridge.Participant{SeenKnown: true}, now); ok {
		t.Fatal("a zero time is not a time")
	}
	past := now.Add(-time.Hour)
	if got, ok := seenOf(bridge.Participant{SeenKnown: true, Seen: past}, now); !ok || !got.Equal(past) {
		t.Fatalf("got %v %v, want %v", got, ok, past)
	}
	if got, ok := seenOf(bridge.Participant{SeenKnown: true, Seen: now.Add(time.Hour)}, now); !ok || !got.Equal(now) {
		t.Fatalf("a future time is held at now, got %v", got)
	}
}
