package engine_test

import (
	"context"
	"fmt"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/contracttest"
	"app.local/server/internal/chat"
)

func (e *env) seqOf(chatID int64, ext string) int64 {
	e.t.Helper()
	var seq int64
	if err := e.st.Pool().QueryRow(context.Background(), `SELECT seq FROM external_messages WHERE chat_id = $1 AND external_msg_id = $2`, chatID, ext).Scan(&seq); err != nil {
		e.t.Fatal(err)
	}
	return seq
}

func (e *env) pinRows(chatID int64) int {
	var n int
	if err := e.st.Pool().QueryRow(context.Background(), `SELECT count(*) FROM external_outbox WHERE chat_id = $1 AND op IN ('pin_message', 'pin_topic')`, chatID).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

func (e *env) topicPinned(chatID int64, title string) bool {
	var pinned bool
	if err := e.st.Pool().QueryRow(context.Background(), `SELECT pinned FROM forum_topics WHERE chat_id = $1 AND title = $2`, chatID, title).Scan(&pinned); err != nil {
		e.t.Fatal(err)
	}
	return pinned
}

func (e *env) topicIDByTitle(chatID int64, title string) int64 {
	e.t.Helper()
	for id, t := range e.topics(chatID) {
		if t == title {
			return id
		}
	}
	e.t.Fatalf("no topic %q", title)
	return 0
}

func TestPinningAndUnpinningInChatReachTheOtherApp(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	chatID := e.twoWay()
	seq := e.seqOf(chatID, "m1")
	if _, err := e.chat.PinMessage(ctx, e.owner, chatID, seq); err != nil {
		t.Fatal(err)
	}
	e.waitOutbox(chatID, seq, "pin_message", "sent")
	if got := fmt.Sprint(e.fake.Pins()); got != "[{g1 m1  true}]" {
		t.Fatalf("pins = %v, want m1 pinned in g1", got)
	}
	// The other app tells the owner about the pin (EchoSent); Chat is already
	// there and stays pinned once.
	e.waitPinned(chatID, []string{"tin 1"})
	if _, err := e.chat.UnpinMessage(ctx, e.owner, chatID, seq); err != nil {
		t.Fatal(err)
	}
	e.waitOutbox(chatID, seq, "pin_message", "sent")
	e.eventually(func() bool { return len(e.fake.Pins()) == 2 }, func() string { return fmt.Sprint(e.fake.Pins()) })
	if got := e.fake.Pins()[1]; got.Pinned || got.Message != "m1" {
		t.Fatalf("second call = %+v, want the unpin of m1", got)
	}
	e.waitPinned(chatID, nil)
}

func TestPinsMadeInQuickSuccessionSendOnlyTheLastState(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	chatID := e.twoWay()
	seq := e.seqOf(chatID, "m1")
	e.stop() // the rows wait in the outbox
	for _, pin := range []bool{true, false, true, false} {
		var err error
		if pin {
			_, err = e.chat.PinMessage(ctx, e.owner, chatID, seq)
		} else {
			_, err = e.chat.UnpinMessage(ctx, e.owner, chatID, seq)
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	if n := e.pinRows(chatID); n != 1 {
		t.Fatalf("%d pin rows for one message, want 1", n)
	}
	e.start()
	e.waitOutbox(chatID, seq, "pin_message", "sent")
	if got := fmt.Sprint(e.fake.Pins()); got != "[{g1 m1  false}]" {
		t.Fatalf("pins = %v, want the one unpin (the last state)", got)
	}
}

func TestAPinTheOtherAppRefusesIsPutBackInChat(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	chatID := e.twoWay()
	seq := e.seqOf(chatID, "m2")
	e.fake.FailPin(fmt.Errorf("%w: CHAT_ADMIN_REQUIRED", bridge.ErrNotAllowed))
	if _, err := e.chat.PinMessage(ctx, e.owner, chatID, seq); err != nil {
		t.Fatal(err)
	}
	e.waitOutbox(chatID, seq, "pin_message", "failed")
	e.waitPinned(chatID, nil)
	if n := len(e.fake.Pins()); n != 0 {
		t.Fatalf("%d pins reached the other app, want none", n)
	}
	// The owner is told once, as a pin and not as a failed message.
	eng := e.engine()
	items, err := eng.Outbox(ctx, e.owner, chatID)
	if err != nil || len(items) != 1 || items[0].Op != "pin_message" || items[0].Seq != seq || items[0].Status != "failed" || items[0].LastError == "" {
		t.Fatalf("outbox items = %+v (%v), want the one refused pin with its reason", items, err)
	}
	if items, err = eng.Outbox(ctx, e.owner, chatID); err != nil || len(items) != 0 {
		t.Fatalf("outbox items = %+v (%v), want none the second time", items, err)
	}
}

func TestAChatThatOnlyReadsKeepsItsPinsToItself(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	conv := e.group("g1")
	e.fake.AddHistory("g1", e.msg("m1", lan, "tin 1", 1))
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"tin 1"})
	if _, err := e.chat.PinMessage(ctx, e.owner, chatID, e.seqOf(chatID, "m1")); err != nil {
		t.Fatal(err)
	}
	e.waitPinned(chatID, []string{"tin 1"})
	if n := e.pinRows(chatID); n != 0 {
		t.Fatalf("%d pin rows for a chat that only reads, want none", n)
	}
}

func TestPinningATopicInChatPinsItInTheOtherAppAndOtherTopicChangesStayRefused(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	conv := e.forumConv()
	e.fake.AddHistory("g1", e.inTopic("m1", lan, "tin 1", "7", 1))
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"tin 1"})
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	if err := e.chat.SetImportedDirection(ctx, e.owner, chatID, chat.DirectionBoth); err != nil {
		t.Fatal(err)
	}
	topic := e.topicIDByTitle(chatID, "Hạ tầng")
	pinned := true
	if _, _, err := e.chat.EditForumTopic(ctx, e.owner, &appv1.EditForumTopicRequest{ChatId: chatID, TopicId: topic, Pinned: &pinned}); err != nil {
		t.Fatal(err)
	}
	e.waitOutbox(chatID, topic, "pin_topic", "sent")
	if got := fmt.Sprint(e.fake.Pins()); got != "[{g1  7 true}]" {
		t.Fatalf("pins = %v, want topic 7 pinned in g1", got)
	}
	if !e.topicPinned(chatID, "Hạ tầng") {
		t.Fatal("the topic is not pinned in Chat")
	}
	title := "Tên khác"
	if _, _, err := e.chat.EditForumTopic(ctx, e.owner, &appv1.EditForumTopicRequest{ChatId: chatID, TopicId: topic, Title: &title}); err == nil {
		t.Fatal("renaming a topic of a linked chat was allowed")
	}
	if _, _, err := e.chat.EditForumTopic(ctx, e.owner, &appv1.EditForumTopicRequest{ChatId: chatID, TopicId: topic, Title: &title, Pinned: &pinned}); err == nil {
		t.Fatal("renaming together with pinning was allowed")
	}
}

func TestATopicPinTheOtherAppRefusesIsPutBackInChat(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	conv := e.forumConv()
	e.fake.AddHistory("g1", e.inTopic("m1", lan, "tin 1", "9", 1))
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"tin 1"})
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	if err := e.chat.SetImportedDirection(ctx, e.owner, chatID, chat.DirectionBoth); err != nil {
		t.Fatal(err)
	}
	topic := e.topicIDByTitle(chatID, "Thiết kế")
	e.fake.FailPin(fmt.Errorf("%w: CHAT_ADMIN_REQUIRED", bridge.ErrNotAllowed))
	pinned := true
	if _, _, err := e.chat.EditForumTopic(ctx, e.owner, &appv1.EditForumTopicRequest{ChatId: chatID, TopicId: topic, Pinned: &pinned}); err != nil {
		t.Fatal(err)
	}
	e.waitOutbox(chatID, topic, "pin_topic", "failed")
	e.eventually(func() bool { return !e.topicPinned(chatID, "Thiết kế") }, func() string { return "the refused pin is still in Chat" })
}

var _ = contracttest.PinCall{}
