package engine_test

import (
	"context"
	"testing"
	"time"

	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/engine"
)

// chatOf is the chat that copies a conversation, 0 when it has none.
func (e *env) chatOf(conv string) int64 {
	var id int64
	_ = e.st.Pool().QueryRow(context.Background(), `SELECT chat_id FROM external_chats WHERE account_id = $1 AND external_chat_id = $2`, e.account, conv).Scan(&id)
	return id
}

func (e *env) syncState() string {
	var s string
	if err := e.st.Pool().QueryRow(context.Background(), `SELECT sync_state FROM external_accounts WHERE id = $1`, e.account).Scan(&s); err != nil {
		e.t.Fatal(err)
	}
	return s
}

func TestOneSwitchSyncsEveryConversationAndGoesLive(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	e.group("g1")
	e.fake.AddHistory("g1", e.msg("m1", lan, "nhóm một", 1))
	e.group("g2")
	e.fake.AddHistory("g2", e.msg("n1", minh, "nhóm hai", 2))
	e.fake.AddConversation(bridge.Conversation{ID: "p1", Kind: bridge.ConvPrivate, Title: "Lan", Peer: &lan})
	e.fake.AddHistory("p1", e.msg("q1", lan, "chào", 3))
	eng := e.start()

	time.Sleep(200 * time.Millisecond)
	if e.chatOf("g1") != 0 || e.syncState() != engine.SyncOff {
		t.Fatalf("something was synced before the switch was turned on (state %s)", e.syncState())
	}
	if err := eng.StartSync(ctx, e.owner, e.account); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool { return e.chatOf("g1") != 0 && e.chatOf("g2") != 0 && e.chatOf("p1") != 0 },
		func() string { return "not every conversation got a chat" })
	e.waitTexts(e.chatOf("g1"), []string{"nhóm một"})
	e.waitTexts(e.chatOf("g2"), []string{"nhóm hai"})
	e.waitTexts(e.chatOf("p1"), []string{"chào"})
	e.eventually(func() bool { return e.syncState() == engine.SyncLive }, func() string { return "state " + e.syncState() })
	// every chat is two-way
	var both int
	if err := e.st.Pool().QueryRow(ctx, `SELECT count(*) FROM external_chats WHERE account_id = $1 AND direction = 'both'`, e.account).Scan(&both); err != nil || both != 3 {
		t.Fatalf("%d two-way chats (err %v), want 3", both, err)
	}
	// turning it on again changes nothing
	if err := eng.StartSync(ctx, e.owner, e.account); err != nil || e.syncState() != engine.SyncLive {
		t.Fatalf("again: %v, state %s", err, e.syncState())
	}
}

func TestAConversationThatAppearsLaterJoinsOnItsOwnWithItsMessage(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	e.group("g1")
	e.fake.AddHistory("g1", e.msg("m1", lan, "nhóm một", 1))
	eng := e.start()
	if err := eng.StartSync(ctx, e.owner, e.account); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool { return e.syncState() == engine.SyncLive }, func() string { return "state " + e.syncState() })

	// somebody writes from a conversation Chat has never seen
	e.group("g3")
	first := e.msg("x1", minh, "nhóm mới", 5)
	first.Conversation = "g3"
	e.fake.Push(bridge.Event{Message: &first})
	e.eventually(func() bool { return e.chatOf("g3") != 0 }, func() string { return "the new conversation got no chat" })
	e.waitTexts(e.chatOf("g3"), []string{"nhóm mới"})
}
