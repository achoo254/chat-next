package engine_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/bridge"
	"app.local/server/internal/chat"
	"google.golang.org/protobuf/proto"
)

// forwardOf is the "forwarded from" of the message at seq: the puppet's external id
// or the name, "" when the message is not a forward.
func (e *env) forwardOf(chatID, seq int64) string {
	e.t.Helper()
	var raw []byte
	if err := e.st.Pool().QueryRow(context.Background(), `SELECT content FROM messages WHERE chat_id = $1 AND seq = $2`, chatID, seq).Scan(&raw); err != nil {
		e.t.Fatal(err)
	}
	var m appv1.Message
	if err := proto.Unmarshal(raw, &m); err != nil {
		e.t.Fatal(err)
	}
	h := m.GetForwardFrom()
	if h == nil {
		return ""
	}
	if h.GetFromUserId() != 0 {
		var id string
		if err := e.st.Pool().QueryRow(context.Background(), `SELECT external_user_id FROM external_users WHERE user_id = $1`, h.GetFromUserId()).Scan(&id); err != nil {
			e.t.Fatal(err)
		}
		return id
	}
	return h.GetFromName()
}

func TestAForwardedMessageOfTheOtherAppKeepsItsForwardedFrom(t *testing.T) {
	e := newEnv(t)
	chatID := e.twoWay()
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	byPerson := e.msg("m3", lan, "tin chuyển tiếp", 3)
	byPerson.Forward = &bridge.ForwardInfo{From: &minh, Name: "Minh", Date: time.Now().Add(-48 * time.Hour)}
	byChannel := e.msg("m4", lan, "tin của kênh", 4)
	byChannel.Forward = &bridge.ForwardInfo{Name: "Kênh tin tức", Date: time.Now().Add(-48 * time.Hour)}
	e.fake.Push(bridge.Event{Message: &byPerson})
	e.fake.Push(bridge.Event{Message: &byChannel})
	e.waitTexts(chatID, []string{"tin 1", "tin 2", "tin chuyển tiếp", "tin của kênh"})
	if got := e.forwardOf(chatID, e.seqOf(chatID, "m3")); got != "u-minh" {
		t.Fatalf("forwarded from = %q, want the puppet of Minh", got)
	}
	if got := e.forwardOf(chatID, e.seqOf(chatID, "m4")); got != "Kênh tin tức" {
		t.Fatalf("forwarded from = %q, want the channel's name", got)
	}
	if got := e.forwardOf(chatID, e.seqOf(chatID, "m1")); got != "" {
		t.Fatalf("a plain message reads as forwarded from %q", got)
	}
}

func TestAForwardFromAPersonTheUpdateDidNotNameShowsThePuppetsName(t *testing.T) {
	e := newEnv(t)
	chatID := e.twoWay()
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	unnamed := bridge.Participant{ID: minh.ID, Name: "Telegram " + minh.ID, NameUnknown: true}
	m := e.msg("m3", lan, "tin chuyển tiếp", 3)
	m.Forward = &bridge.ForwardInfo{From: &unnamed, Name: unnamed.Name, Date: time.Now().Add(-48 * time.Hour)}
	e.fake.Push(bridge.Event{Message: &m})
	e.waitTexts(chatID, []string{"tin 1", "tin 2", "tin chuyển tiếp"})
	if got := e.forwardOf(chatID, e.seqOf(chatID, "m3")); got != minh.ID {
		t.Fatalf("forwarded from = %q, want the puppet of Minh", got)
	}
	var raw []byte
	if err := e.st.Pool().QueryRow(context.Background(), `SELECT content FROM messages WHERE chat_id = $1 AND seq = $2`, chatID, e.seqOf(chatID, "m3")).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var msg appv1.Message
	if err := proto.Unmarshal(raw, &msg); err != nil {
		t.Fatal(err)
	}
	if name := msg.GetForwardFrom().GetFromName(); name != "" {
		t.Fatalf("forward header carries the stand-in name %q", name)
	}
}

func TestForwardingBetweenTwoSyncedChatsIsANativeForward(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	from := e.twoWay() // g1, with m1 and m2
	conv := e.group("g2")
	e.fake.AddHistory("g2", e.msg("n1", minh, "nhóm hai", 1))
	to, err := e.start().EnableChat(ctx, e.account, conv, 100)
	if err != nil {
		t.Fatal(err)
	}
	e.waitTexts(to, []string{"nhóm hai"})
	if err := e.chat.SetImportedDirection(ctx, e.owner, to, chat.DirectionBoth); err != nil {
		t.Fatal(err)
	}
	if _, err := e.chat.ForwardMessages(ctx, e.owner, &appv1.ForwardMessagesRequest{FromChatId: from, Seqs: []int64{e.seqOf(from, "m1")}, ToChatId: to, RandomIds: []int64{7}}); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool { return fmt.Sprint(e.fake.Forwards()) == "[g1:m1>g2]" }, func() string { return fmt.Sprint(e.fake.Forwards(), e.fake.Sent()) })
	if n := len(e.fake.Sent()); n != 0 {
		t.Fatalf("the forward was also sent as %d plain messages", n)
	}
	e.waitOutbox(to, e.lastSeq(to), "send", "sent")
}

func TestForwardingAMessageOnlyChatHasSendsACopy(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	to := e.twoWay()
	e.eventually(func() bool { return e.backfillDone(to) }, func() string { return "backfill not done" })
	g, err := e.chat.CreateGroup(ctx, e.owner, "Chỉ ở Chat", nil, false)
	if err != nil {
		t.Fatal(err)
	}
	src := g.GetChat().GetId()
	sent, err := e.chat.SendMessage(ctx, e.owner, &appv1.SendMessageRequest{ChatId: src, Text: "tin chỉ ở Chat"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.chat.ForwardMessages(ctx, e.owner, &appv1.ForwardMessagesRequest{FromChatId: src, Seqs: []int64{sent.GetMessage().GetSeq()}, ToChatId: to, RandomIds: []int64{8}}); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool { return len(e.fake.Sent()) == 1 }, func() string { return fmt.Sprint(e.fake.Sent()) })
	if got := e.fake.Sent()[0].Text; got != "tin chỉ ở Chat" {
		t.Fatalf("copy text = %q", got)
	}
	if n := len(e.fake.Forwards()); n != 0 {
		t.Fatalf("%d native forwards for a message the app does not have", n)
	}
}

// lastSeq is the newest message of a chat.
func (e *env) lastSeq(chatID int64) int64 {
	var seq int64
	if err := e.st.Pool().QueryRow(context.Background(), `SELECT max(seq) FROM messages WHERE chat_id = $1`, chatID).Scan(&seq); err != nil {
		e.t.Fatal(err)
	}
	return seq
}
