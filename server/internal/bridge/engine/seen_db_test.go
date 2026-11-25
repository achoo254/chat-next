package engine_test

import (
	"context"
	"testing"
	"time"

	"app.local/server/internal/bridge"
)

func withSeen(p bridge.Participant, at time.Time) bridge.Participant {
	p.SeenKnown, p.Seen = true, at
	return p
}

// seenAt is the recorded last-seen time of a person's puppet, nil when none.
func (e *env) seenAt(person string) *time.Time {
	e.t.Helper()
	var at *time.Time
	if err := e.st.Pool().QueryRow(context.Background(), `
		SELECT u.last_seen_at FROM external_users x JOIN users u ON u.id = x.user_id
		WHERE x.account_id = $1 AND x.external_user_id = $2`, e.account, person).Scan(&at); err != nil {
		e.t.Fatal(err)
	}
	return at
}

func TestALastSeenTimeIsRecordedOnThePuppetAndOnlyMovesForward(t *testing.T) {
	e := newEnv(t)
	first := time.Now().Add(-3 * time.Hour).Truncate(time.Second)
	seen := withSeen(lan, first)
	conv := bridge.Conversation{ID: "dm1", Kind: bridge.ConvPrivate, Peer: &seen}
	e.fake.AddConversation(conv)
	e.fake.AddHistory("dm1", e.msg("1", seen, "chào", 0))
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"chào"})
	got := e.seenAt(lan.ID)
	if got == nil || !got.Equal(first) {
		t.Fatalf("recorded %v, want %v", got, first)
	}
	// A later time moves it; an older one does not.
	later := first.Add(time.Hour)
	e.pushDM("2", withSeen(lan, later), "hai", 1)
	e.waitTexts(chatID, []string{"chào", "hai"})
	if got := e.seenAt(lan.ID); got == nil || !got.Equal(later) {
		t.Fatalf("recorded %v, want %v", got, later)
	}
	e.pushDM("3", withSeen(lan, first), "ba", 2)
	e.waitTexts(chatID, []string{"chào", "hai", "ba"})
	if got := e.seenAt(lan.ID); got == nil || !got.Equal(later) {
		t.Fatalf("an older time moved it to %v", got)
	}
}
