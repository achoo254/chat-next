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

func TestAConversationTheOtherAppRefusesDoesNotStopTheSyncOfTheOthers(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	e.group("g1")
	e.fake.AddHistory("g1", e.msg("m1", lan, "nhóm một", 1))
	e.group("bad")
	e.fake.AddHistory("bad", e.msg("b1", lan, "không đọc được", 1))
	e.group("g2")
	e.fake.AddHistory("g2", e.msg("n1", minh, "nhóm hai", 2))
	e.fake.SetGroupInfoRemotely("g2", bridge.GroupInfo{Title: "Nhóm hai đổi tên", About: ""})
	e.fake.SetDialogState("g2", bridge.DialogState{Pinned: true})
	e.fake.Refuse("bad")
	eng := e.start()
	if err := eng.StartSync(ctx, e.owner, e.account); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool { return e.syncState() == engine.SyncLive }, func() string { return "state " + e.syncState() })
	e.waitTexts(e.chatOf("g1"), []string{"nhóm một"})
	e.waitTexts(e.chatOf("g2"), []string{"nhóm hai"})
	// the looks at the state go on past the refused conversation
	e.eventually(func() bool { t2, _ := e.chatInfo(e.chatOf("g2")); return t2 == "Nhóm hai đổi tên" }, func() string { return "the info of g2 did not come in" })
	e.waitOwner(e.chatOf("g2"), func(s ownerState) bool { return s.pinned }, "the state of g2 did not come in")
	// and the account was never reconnected for it
	if n := e.fake.SubscribeCalls(); n != 1 {
		t.Fatalf("the account connected %d times: a refusal stopped its sync", n)
	}
}

func TestAnImportedConversationRefusedLaterDoesNotKeepTheAccountReconnecting(t *testing.T) {
	e := newEnv(t)
	chatID := e.twoWay()
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	e.fake.Refuse("g1") // its pins, topics, state and info are refused from now on
	e.start()           // a new run reads the pins of every imported chat first
	time.Sleep(500 * time.Millisecond)
	if n := e.fake.SubscribeCalls(); n != 2 {
		t.Fatalf("the account connected %d times over two runs: a refusal stopped a run", n)
	}
	// and it still takes what comes
	m := e.msg("m3", lan, "tin mới", 3)
	e.fake.Push(bridge.Event{Message: &m})
	e.waitTexts(chatID, []string{"tin 1", "tin 2", "tin mới"})
}

func TestAReadTheOtherAppRefusedIsNotAskedAgainEveryLook(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	e.group("g1")
	e.fake.AddHistory("g1", e.msg("m1", lan, "nhóm một", 1))
	e.group("bad")
	e.fake.AddHistory("bad", e.msg("b1", lan, "bị từ chối", 1))
	eng := e.start()
	if err := eng.StartSync(ctx, e.owner, e.account); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool { return e.syncState() == engine.SyncLive }, func() string { return "state " + e.syncState() })
	e.fake.Refuse("bad")
	// many looks: the invites of each group are read once in five
	e.eventually(func() bool { return e.fake.InviteReads("g1") >= 4 }, func() string { return "the invites are not read" })
	if n := e.fake.InviteReads("bad"); n > 2 {
		t.Fatalf("the refused conversation was asked %d times, want it left alone after the refusal", n)
	}
}
