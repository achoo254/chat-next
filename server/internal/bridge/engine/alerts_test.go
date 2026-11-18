package engine_test

import (
	"context"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"google.golang.org/protobuf/proto"

	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/feature"
)

// unreadOf is how many messages of the chat the owner has not read.
func (e *env) unreadOf(chatID int64) int64 {
	e.t.Helper()
	var n int64
	if err := e.st.Pool().QueryRow(context.Background(), `
		SELECT c.last_seq - coalesce((SELECT read_inbox_max_seq FROM chat_read_states WHERE chat_id = c.id AND user_id = $2 AND topic_id = 0), 0)
		FROM chats c WHERE c.id = $1`, chatID, e.owner).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

func (e *env) silentCount(chatID int64) int {
	e.t.Helper()
	rows, err := e.st.Pool().Query(context.Background(), `SELECT content FROM messages WHERE chat_id = $1 AND text <> ''`, chatID)
	if err != nil {
		e.t.Fatal(err)
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			e.t.Fatal(err)
		}
		var m appv1.Message
		if err := proto.Unmarshal(raw, &m); err != nil {
			e.t.Fatal(err)
		}
		if m.GetSilent() {
			n++
		}
	}
	return n
}

func TestANewMessageNotifiesOnlyWhenAlertsReceiveAndHistoryNever(t *testing.T) {
	e := newEnv(t)
	eng, chatID := e.peopleChat(feature.Alerts, feature.Off)
	// off: arrives silent and read, as before
	e.fake.Push(bridge.Event{Message: ptr(e.msg("m2", minh, "tin 2", 2))})
	e.waitTexts(chatID, []string{"tin 1", "tin 2"})
	if e.unreadOf(chatID) != 0 || e.silentCount(chatID) != 2 {
		t.Fatalf("alerts off: unread %d silent %d, want 0 and 2", e.unreadOf(chatID), e.silentCount(chatID))
	}
	if err := eng.SetFeature(context.Background(), e.owner, e.account, "g1", feature.Alerts, feature.In); err != nil {
		t.Fatal(err)
	}
	e.fake.Push(bridge.Event{Message: ptr(e.msg("m3", minh, "tin 3", 3))})
	e.waitTexts(chatID, []string{"tin 1", "tin 2", "tin 3"})
	if e.unreadOf(chatID) != 1 || e.silentCount(chatID) != 2 {
		t.Fatalf("alerts on: unread %d silent %d, want 1 and 2", e.unreadOf(chatID), e.silentCount(chatID))
	}
	// what the owner sent from the other app never notifies
	e.fake.Push(bridge.Event{Message: ptr(e.msg("m4", me, "tin 4", 4))})
	e.waitTexts(chatID, []string{"tin 1", "tin 2", "tin 3", "tin 4"})
	if e.silentCount(chatID) != 3 {
		t.Fatalf("a message of the owner notified: silent %d, want 3", e.silentCount(chatID))
	}
	// and it does not wipe out the unread of the message that notified before it
	if e.unreadOf(chatID) == 0 {
		t.Fatal("the owner's own message marked the earlier message that notified as read")
	}
}

func TestWhatTheOwnerReadInChatIsToldToTheOtherApp(t *testing.T) {
	e := newEnv(t)
	_, chatID := e.peopleChat(feature.Read, feature.Both)
	if _, err := e.chat.ReadHistory(context.Background(), e.owner, chatID, 1, 0); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool { return len(e.fake.MarkReads()) > 0 }, func() string { return "the other app was not told" })
	if got := e.fake.MarkReads()[0]; got != "g1:m1" {
		t.Fatalf("told %q, want g1:m1", got)
	}
}

func TestReadingStaysInChatWhenTheFeatureDoesNotSend(t *testing.T) {
	e := newEnv(t)
	_, chatID := e.peopleChat(feature.Read, feature.In)
	if _, err := e.chat.ReadHistory(context.Background(), e.owner, chatID, 1, 0); err != nil {
		t.Fatal(err)
	}
	time.Sleep(400 * time.Millisecond)
	if n := len(e.fake.MarkReads()); n != 0 {
		t.Fatalf("%d reads sent although the feature only receives", n)
	}
}

func TestReadingOnAnotherDeviceOfTheOtherAppMovesTheOwnersPosition(t *testing.T) {
	e := newEnv(t)
	_, chatID := e.peopleChat(feature.Alerts, feature.In)
	e.fake.Push(bridge.Event{Message: ptr(e.msg("2", minh, "tin 2", 2))})
	e.fake.Push(bridge.Event{Message: ptr(e.msg("3", minh, "tin 3", 3))})
	e.waitTexts(chatID, []string{"tin 1", "tin 2", "tin 3"})
	if e.unreadOf(chatID) != 2 {
		t.Fatalf("unread %d, want 2", e.unreadOf(chatID))
	}
	e.fake.Push(bridge.Event{Seen: &bridge.Seen{Conversation: "g1", MaxID: "2"}})
	e.eventually(func() bool { return e.unreadOf(chatID) == 1 }, func() string { return "position did not move" })
}
