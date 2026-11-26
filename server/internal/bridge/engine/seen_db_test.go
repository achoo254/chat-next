package engine_test

import (
	"context"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
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

// puppetStatus is how the owner sees the presence of a person's puppet (GetUsers).
func (e *env) puppetStatus(person string) *appv1.UserStatus {
	e.t.Helper()
	var id int64
	if err := e.st.Pool().QueryRow(context.Background(), `
		SELECT user_id FROM external_users WHERE account_id = $1 AND external_user_id = $2`, e.account, person).Scan(&id); err != nil {
		e.t.Fatal(err)
	}
	users, err := e.chat.GetUsers(context.Background(), e.owner, []int64{id})
	if err != nil || len(users) != 1 {
		e.t.Fatalf("users %v, err %v", users, err)
	}
	return users[0].GetStatus()
}

// waitStatus waits until the owner sees the person's presence of the given kind.
func (e *env) waitStatus(person string, kind appv1.UserStatusKind) {
	e.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		got := e.puppetStatus(person)
		if got.GetKind() == kind {
			return
		}
		if time.Now().After(deadline) {
			e.t.Fatalf("status %v, want %v", got, kind)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestAPuppetShowsThePresenceTheOtherAppStates(t *testing.T) {
	e := newEnv(t)
	online := withSeen(lan, time.Now())
	online.OnlineUntil = time.Now().Add(5 * time.Minute)
	conv := bridge.Conversation{ID: "dm1", Kind: bridge.ConvPrivate, Peer: &online}
	e.fake.AddConversation(conv)
	e.fake.AddHistory("dm1", e.msg("1", online, "chào", 0))
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"chào"})
	e.waitStatus(lan.ID, appv1.UserStatusKind_USER_STATUS_KIND_ONLINE)

	// A status update alone: the person hides the time and went offline "recently".
	recently := bridge.Participant{ID: lan.ID, SeenKnown: true, Seen: time.Now().Add(-24 * time.Hour), SeenBand: bridge.SeenRecently}
	e.fake.Push(bridge.Event{Participant: &recently})
	e.waitStatus(lan.ID, appv1.UserStatusKind_USER_STATUS_KIND_RECENTLY)

	// An exact time is shown as that time.
	at := time.Now().Add(-2 * time.Hour).Truncate(time.Second)
	exact := bridge.Participant{ID: lan.ID, SeenKnown: true, Seen: at}
	e.fake.Push(bridge.Event{Participant: &exact})
	e.waitStatus(lan.ID, appv1.UserStatusKind_USER_STATUS_KIND_OFFLINE)
}
