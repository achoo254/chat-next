package engine_test

import (
	"context"
	"errors"
	"fmt"
	"testing"

	appv1 "app.local/server/gen/app/v1"
)

// topicsTitled counts the topics of a chat with a title.
func (e *env) topicsTitled(chatID int64, title string) int {
	var n int
	if err := e.st.Pool().QueryRow(context.Background(), `SELECT count(*) FROM forum_topics WHERE chat_id = $1 AND title = $2`, chatID, title).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

func (e *env) openTopic(chatID int64, title string) int64 {
	e.t.Helper()
	topic, _, err := e.chat.CreateForumTopic(context.Background(), e.owner, &appv1.CreateForumTopicRequest{ChatId: chatID, Title: title})
	if err != nil {
		e.t.Fatal(err)
	}
	return topic.GetId()
}

func (e *env) sayIn(chatID, topic int64, text string) {
	e.t.Helper()
	if _, err := e.chat.SendMessage(context.Background(), e.owner, &appv1.SendMessageRequest{ChatId: chatID, TopicId: topic, Text: text}); err != nil {
		e.t.Fatal(err)
	}
}

func TestATopicOpenedInChatIsOpenedInTheOtherAppOnceAndTakesItsMessages(t *testing.T) {
	e := newEnv(t)
	chatID, _ := e.twoWayForum()
	topic := e.openTopic(chatID, "Kế hoạch")
	e.eventually(func() bool { return fmt.Sprint(e.fake.CreatedTopics()) == "[g1:Kế hoạch]" }, func() string { return fmt.Sprint(e.fake.CreatedTopics()) })
	e.sayIn(chatID, topic, "tin vào chủ đề mới")
	e.eventually(func() bool { return len(e.fake.Sent()) == 1 }, func() string { return fmt.Sprint(e.fake.Sent()) })
	sent := e.fake.Sent()[0]
	if sent.Topic == "" || sent.Topic == "7" || sent.Topic == "1" {
		t.Fatalf("the message went to topic %q, want the new one", sent.Topic)
	}
	// The other app told of the new topic: Chat still has it once.
	if n := e.topicsTitled(chatID, "Kế hoạch"); n != 1 {
		t.Fatalf("%d topics named Kế hoạch in Chat, want 1", n)
	}
}

func TestAMessageForATopicStillBeingOpenedWaitsForIt(t *testing.T) {
	e := newEnv(t)
	chatID, _ := e.twoWayForum()
	e.stop()
	e.fake.FailPin(errors.New("flaky")) // the first try to open the topic fails
	topic := e.openTopic(chatID, "Kế hoạch")
	e.sayIn(chatID, topic, "tin vào chủ đề mới")
	e.start()
	e.eventually(func() bool { return len(e.fake.Sent()) == 1 }, func() string { return fmt.Sprint(e.fake.Sent()) })
	if got := e.fake.Sent()[0].Topic; got == "" || got == "1" {
		t.Fatalf("the message went to topic %q, want the new one", got)
	}
	if n := e.topicsTitled(chatID, "Kế hoạch"); n != 1 {
		t.Fatalf("%d topics named Kế hoạch in Chat, want 1", n)
	}
}

func TestAChatThatOnlyReadsStillCannotOpenTopics(t *testing.T) {
	e := newEnv(t)
	conv := e.forumConv()
	e.fake.AddHistory("g1", e.inTopic("m1", lan, "tin 1", "7", 1))
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"tin 1"})
	if _, _, err := e.chat.CreateForumTopic(context.Background(), e.owner, &appv1.CreateForumTopicRequest{ChatId: chatID, Title: "Mới"}); err == nil {
		t.Fatal("a chat that only reads opened a topic")
	}
}
