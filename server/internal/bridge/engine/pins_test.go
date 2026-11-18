package engine_test

import (
	"context"
	"fmt"
	"testing"

	"app.local/server/internal/bridge"
)

// pinnedTexts lists the texts of the pinned messages of a chat, oldest first.
func (e *env) pinnedTexts(chatID int64) []string {
	e.t.Helper()
	rows, err := e.st.Pool().Query(context.Background(),
		`SELECT m.text FROM pinned_messages p JOIN messages m ON m.chat_id = p.chat_id AND m.seq = p.seq WHERE p.chat_id = $1 ORDER BY p.seq`, chatID)
	if err != nil {
		e.t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			e.t.Fatal(err)
		}
		out = append(out, s)
	}
	return out
}

func (e *env) waitPinned(chatID int64, want []string) {
	e.t.Helper()
	e.eventually(func() bool { return fmt.Sprint(e.pinnedTexts(chatID)) == fmt.Sprint(want) },
		func() string { return fmt.Sprintf("pinned = %v, want %v", e.pinnedTexts(chatID), want) })
}

func TestMessagesPinnedInTheOtherAppArePinnedInChatAfterTheHistoryImport(t *testing.T) {
	e := newEnv(t)
	conv := e.group("g1")
	e.fake.AddHistory("g1", numbered(e, lan, 5)...)
	// "99" is older than the imported history: Chat does not have it.
	e.fake.SetPinned("g1", "4", "2", "99")
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"tin 1", "tin 2", "tin 3", "tin 4", "tin 5"})
	e.waitPinned(chatID, []string{"tin 2", "tin 4"})
}

func TestLivePinsAndUnpinsOfTheOtherAppReachChat(t *testing.T) {
	e := newEnv(t)
	conv := e.group("g1")
	e.fake.AddHistory("g1", numbered(e, lan, 3)...)
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"tin 1", "tin 2", "tin 3"})
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })

	e.fake.Push(bridge.Event{Pin: &bridge.PinChange{Conversation: "g1", IDs: []string{"1", "3", "404"}, Pinned: true}})
	e.waitPinned(chatID, []string{"tin 1", "tin 3"})
	// Repeating it, or unpinning what is not pinned, changes nothing.
	e.fake.Push(bridge.Event{Pin: &bridge.PinChange{Conversation: "g1", IDs: []string{"1"}, Pinned: true}})
	e.fake.Push(bridge.Event{Pin: &bridge.PinChange{Conversation: "g1", IDs: []string{"2"}, Pinned: false}})
	e.fake.Push(bridge.Event{Pin: &bridge.PinChange{Conversation: "g1", IDs: []string{"1"}, Pinned: false}})
	e.waitPinned(chatID, []string{"tin 3"})
}

func TestAChatSyncedBeforePinsWereReadGetsThemWhenTheEngineStarts(t *testing.T) {
	e := newEnv(t)
	conv := e.group("g1")
	e.fake.AddHistory("g1", numbered(e, lan, 3)...)
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"tin 1", "tin 2", "tin 3"})
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	if got := e.pinnedTexts(chatID); len(got) != 0 {
		t.Fatalf("pinned before anything was pinned: %v", got)
	}
	e.fake.SetPinned("g1", "3", "1")
	e.start()
	e.waitPinned(chatID, []string{"tin 1", "tin 3"})
}
