package engine_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	appv1 "app.local/server/gen/app/v1"
)

func TestAStateTheOtherAppKeepsRefusingDoesNotHoldUpTheRestOfTheChat(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	chatID, topic := e.twoWayForum()
	e.fake.FailTopicEdits(errors.New("flaky")) // tried again and again, not refused for good
	title := "Hạ tầng mới"
	if _, _, err := e.chat.EditForumTopic(ctx, e.owner, &appv1.EditForumTopicRequest{ChatId: chatID, TopicId: topic, Title: &title}); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool {
		return e.outboxStatus(chatID, topic, "set_topic") == "pending" && e.outboxAttempts(chatID, topic, "set_topic") > 0
	},
		func() string { return "the topic edit was not tried" })

	// Later changes of other things in the same chat go out while it is still being tried.
	e.react(chatID, e.seqOf(chatID, "m1"), "👍")
	if _, err := e.chat.SetDialogPinned(ctx, e.owner, chatID, true); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool { return len(e.fake.ReactionCalls()) == 1 && len(e.fake.DialogCalls()) == 1 },
		func() string { return fmt.Sprint(e.fake.ReactionCalls(), e.fake.DialogCalls()) })
	if s := e.outboxStatus(chatID, topic, "set_topic"); s != "pending" {
		t.Fatalf("the topic edit is %s by the time the others went; they waited for it", s)
	}
	e.fake.FailTopicEdits(nil)
	e.waitOutbox(chatID, topic, "set_topic", "sent")
}

func TestAReactionToAMessageStillBeingSentWaitsForItInsteadOfBeingDropped(t *testing.T) {
	e := newEnv(t)
	chatID := e.twoWay()
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	e.stop()
	e.fake.FailSend(errors.New("flaky"), errors.New("flaky"))
	seq := e.say(chatID, "tin mới")
	e.react(chatID, seq, "🔥")
	e.start()
	e.waitOutbox(chatID, seq, "set_reaction", "sent")
	calls := e.fake.ReactionCalls()
	if len(calls) != 1 || !strings.HasSuffix(calls[0], ":🔥") {
		t.Fatalf("reaction calls = %v", calls)
	}
	if n := len(e.fake.Sent()); n != 1 {
		t.Fatalf("%d messages sent, want 1", n)
	}
}

// outboxAttempts is how many times a row was tried.
func (e *env) outboxAttempts(chatID, seq int64, op string) int {
	var n int
	if err := e.st.Pool().QueryRow(context.Background(), `SELECT attempts FROM external_outbox WHERE chat_id = $1 AND seq = $2 AND op = $3`, chatID, seq, op).Scan(&n); err != nil {
		return 0
	}
	return n
}
