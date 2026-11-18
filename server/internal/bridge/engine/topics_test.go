package engine_test

import (
	"context"
	"fmt"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/bridge"
	"app.local/server/internal/chat"
)

// forumConv is the conversation g1 as a forum with the General topic and two others.
func (e *env) forumConv() bridge.Conversation {
	c := bridge.Conversation{ID: "g1", Kind: bridge.ConvGroup, Title: "Diễn đàn", Forum: true}
	e.fake.AddConversation(c)
	e.fake.AddTopic("g1", bridge.Topic{ID: "1", Title: "General", General: true})
	e.fake.AddTopic("g1", bridge.Topic{ID: "7", Title: "Hạ tầng", IconColor: 0x6FB9F0, Created: e.at(1)})
	e.fake.AddTopic("g1", bridge.Topic{ID: "9", Title: "Thiết kế", Created: e.at(2)})
	return c
}

func (e *env) inTopic(id string, from bridge.Participant, text, topic string, minutes int) bridge.Message {
	m := e.msg(id, from, text, minutes)
	m.Topic = topic
	return m
}

// topics returns the titles of the chat's topics by Chat topic id.
func (e *env) topics(chatID int64) map[int64]string {
	e.t.Helper()
	rows, err := e.st.Pool().Query(context.Background(), `SELECT id, title FROM forum_topics WHERE chat_id = $1`, chatID)
	if err != nil {
		e.t.Fatal(err)
	}
	defer rows.Close()
	out := map[int64]string{}
	for rows.Next() {
		var id int64
		var title string
		if err := rows.Scan(&id, &title); err != nil {
			e.t.Fatal(err)
		}
		out[id] = title
	}
	return out
}

func (e *env) topicOfText(chatID int64, text string) int64 {
	e.t.Helper()
	var id int64
	if err := e.st.Pool().QueryRow(context.Background(), `SELECT topic_id FROM messages WHERE chat_id = $1 AND text = $2`, chatID, text).Scan(&id); err != nil {
		e.t.Fatalf("topic of %q: %v", text, err)
	}
	return id
}

func (e *env) waitTopic(chatID int64, text string, want int64) {
	e.t.Helper()
	e.eventually(func() bool {
		var id int64
		err := e.st.Pool().QueryRow(context.Background(), `SELECT topic_id FROM messages WHERE chat_id = $1 AND text = $2`, chatID, text).Scan(&id)
		return err == nil && id == want
	}, func() string {
		return fmt.Sprintf("message %q is in topic %d, want %d", text, e.topicOfTextOr(chatID, text), want)
	})
}

func (e *env) topicOfTextOr(chatID int64, text string) int64 {
	var id int64
	if err := e.st.Pool().QueryRow(context.Background(), `SELECT topic_id FROM messages WHERE chat_id = $1 AND text = $2`, chatID, text).Scan(&id); err != nil {
		return -1
	}
	return id
}

func TestAForumConversationBecomesAForumChatWithItsTopicsAndMessagesInThem(t *testing.T) {
	e := newEnv(t)
	conv := e.forumConv()
	e.fake.AddHistory("g1",
		e.inTopic("m1", lan, "hạ tầng 1", "7", 1),
		e.inTopic("m2", minh, "thiết kế 1", "9", 2),
		e.inTopic("m3", lan, "chung 1", "1", 3),
		e.inTopic("m4", lan, "không topic", "", 4),
	)
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"hạ tầng 1", "thiết kế 1", "chung 1", "không topic"})
	var forum bool
	if err := e.st.Pool().QueryRow(context.Background(), `SELECT forum FROM chats WHERE id = $1`, chatID).Scan(&forum); err != nil || !forum {
		t.Fatalf("the copy of a forum is a forum = %v (%v)", forum, err)
	}
	got := e.topics(chatID)
	if len(got) != 3 || got[1] != "General" || got[2] != "Hạ tầng" || got[3] != "Thiết kế" {
		t.Fatalf("topics = %v, want General, Hạ tầng and Thiết kế in the order they were opened", got)
	}
	for text, want := range map[string]int64{"hạ tầng 1": 2, "thiết kế 1": 3, "chung 1": 1, "không topic": 1} {
		if id := e.topicOfText(chatID, text); id != want {
			t.Fatalf("%q is in topic %d, want %d", text, id, want)
		}
	}
}

func TestATopicOfTheOtherAppIsMappedToGeneralAndEveryTopicToOneOfChats(t *testing.T) {
	e := newEnv(t)
	conv := e.forumConv()
	chatID := e.enable(conv, 100)
	e.eventually(func() bool { return len(e.topics(chatID)) == 3 }, func() string { return fmt.Sprint(e.topics(chatID)) })
	rows, err := e.st.Pool().Query(context.Background(), `SELECT external_topic_id, topic_id FROM external_topics WHERE account_id = $1 ORDER BY topic_id`, e.account)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var got []string
	for rows.Next() {
		var ext string
		var id int64
		if err := rows.Scan(&ext, &id); err != nil {
			t.Fatal(err)
		}
		got = append(got, fmt.Sprintf("%s>%d", ext, id))
	}
	if fmt.Sprint(got) != "[1>1 7>2 9>3]" {
		t.Fatalf("mapping = %v, want 1>1 7>2 9>3 (General is the chat's own General)", got)
	}
}

func TestALiveMessageOfANewTopicOpensItWithItsNameOrAPlainOne(t *testing.T) {
	e := newEnv(t)
	conv := e.forumConv()
	chatID := e.enable(conv, 100)
	e.eventually(func() bool { return len(e.topics(chatID)) == 3 }, func() string { return fmt.Sprint(e.topics(chatID)) })
	e.fake.AddTopic("g1", bridge.Topic{ID: "11", Title: "Mới mở", Created: e.at(10)})
	m1 := e.inTopic("n1", lan, "vào topic mới", "11", 10)
	e.fake.Push(bridge.Event{Message: &m1})
	m2 := e.inTopic("n2", lan, "vào topic không ai liệt kê", "12", 11)
	e.fake.Push(bridge.Event{Message: &m2})
	e.waitTexts(chatID, []string{"vào topic mới", "vào topic không ai liệt kê"})
	titles := e.topics(chatID)
	if titles[4] != "Mới mở" || titles[5] != "Topic 12" {
		t.Fatalf("topics = %v, want 4 = Mới mở (named by the list) and 5 = Topic 12 (listed nowhere)", titles)
	}
	if e.topicOfText(chatID, "vào topic mới") != 4 || e.topicOfText(chatID, "vào topic không ai liệt kê") != 5 {
		t.Fatal("the messages are not in the topics that were opened for them")
	}
}

func TestATopicChangeIsAppliedAndAnUnknownTopicIsOpened(t *testing.T) {
	e := newEnv(t)
	conv := e.forumConv()
	chatID := e.enable(conv, 100)
	e.eventually(func() bool { return len(e.topics(chatID)) == 3 }, func() string { return fmt.Sprint(e.topics(chatID)) })
	e.fake.Push(bridge.Event{Topic: &bridge.TopicChange{Conversation: "g1", Topic: bridge.Topic{ID: "7", Title: "Hạ tầng (đổi tên)", IconColor: 0xFF93B2, Closed: true}}})
	e.fake.Push(bridge.Event{Topic: &bridge.TopicChange{Conversation: "g1", Topic: bridge.Topic{ID: "13", Title: "Vừa tạo", Created: e.at(20)}}})
	e.eventually(func() bool {
		return e.topics(chatID)[2] == "Hạ tầng (đổi tên)" && e.topics(chatID)[4] == "Vừa tạo"
	},
		func() string { return fmt.Sprint(e.topics(chatID)) })
	var closed bool
	var color int
	if err := e.st.Pool().QueryRow(context.Background(), `SELECT closed, icon_color FROM forum_topics WHERE chat_id = $1 AND id = 2`, chatID).Scan(&closed, &color); err != nil || !closed || color != 0xFF93B2 {
		t.Fatalf("topic 2 closed=%v colour=%x (%v), want closed with the new colour", closed, color, err)
	}
}

func TestAChatThatHoldsNoMoreTopicsKeepsSyncingWithTheRestInGeneral(t *testing.T) {
	e := newEnv(t)
	conv := e.forumConv()
	chatID := e.enable(conv, 100)
	e.eventually(func() bool { return len(e.topics(chatID)) == 3 }, func() string { return fmt.Sprint(e.topics(chatID)) })
	if _, err := e.st.Pool().Exec(context.Background(), `UPDATE chats SET last_topic_id = 1000 WHERE id = $1`, chatID); err != nil {
		t.Fatal(err)
	}
	e.fake.AddTopic("g1", bridge.Topic{ID: "20", Title: "Topic de trop", Created: e.at(30)})
	over := e.inTopic("o1", lan, "tin của topic thừa", "20", 30)
	e.fake.Push(bridge.Event{Message: &over})
	fine := e.inTopic("o2", lan, "tin của topic có sẵn", "7", 31)
	e.fake.Push(bridge.Event{Message: &fine})
	e.waitTexts(chatID, []string{"tin của topic thừa", "tin của topic có sẵn"})
	if e.topicOfText(chatID, "tin của topic thừa") != 1 || e.topicOfText(chatID, "tin của topic có sẵn") != 2 {
		t.Fatalf("topics of the messages = %d and %d, want General for the one that did not fit and 2 for the other",
			e.topicOfText(chatID, "tin của topic thừa"), e.topicOfText(chatID, "tin của topic có sẵn"))
	}
}

func TestAForumOfAnAppThatDoesNotReadTopicsIsAFlatGroupAsBefore(t *testing.T) {
	e := newEnv(t)
	e.adapter = readOnlyApp{e.fake}
	conv := e.forumConv()
	e.fake.AddHistory("g1", e.inTopic("m1", lan, "một", "7", 1), e.inTopic("m2", lan, "hai", "9", 2))
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"một", "hai"})
	var forum bool
	var mapped int
	if err := e.st.Pool().QueryRow(context.Background(), `SELECT forum, (SELECT count(*) FROM external_topics) FROM chats WHERE id = $1`, chatID).Scan(&forum, &mapped); err != nil || forum || mapped != 0 {
		t.Fatalf("forum=%v mapped=%d (%v), want a flat group with no topic mapping", forum, mapped, err)
	}
}

func TestAMessageWrittenInATopicGoesIntoThatTopicOfTheOtherApp(t *testing.T) {
	e := newEnv(t)
	conv := e.forumConv()
	chatID := e.enable(conv, 100)
	e.eventually(func() bool { return len(e.topics(chatID)) == 3 }, func() string { return fmt.Sprint(e.topics(chatID)) })
	ctx := context.Background()
	if err := e.chat.SetImportedDirection(ctx, e.owner, chatID, chat.DirectionBoth); err != nil {
		t.Fatal(err)
	}
	send := func(text string, topic int64) int64 {
		r, err := e.chat.SendMessage(ctx, e.owner, &appv1.SendMessageRequest{ChatId: chatID, Text: text, TopicId: topic})
		if err != nil {
			t.Fatal(err)
		}
		return r.GetMessage().GetSeq()
	}
	infra, general := send("gửi vào Hạ tầng", 2), send("gửi vào General", 0)
	e.waitOutbox(chatID, infra, "send", "sent")
	e.waitOutbox(chatID, general, "send", "sent")
	sent := e.fake.Sent()
	if len(sent) != 2 || sent[0].Topic != "7" || sent[1].Topic != "1" {
		t.Fatalf("sent = %+v, want the first into topic 7 and the second into General (1)", sent)
	}
	// A Chat topic with no topic behind it in the other app is refused, not guessed.
	if _, err := e.st.Pool().Exec(ctx, `INSERT INTO forum_topics (chat_id, id, title, creator_id) VALUES ($1, 5, 'mồ côi', $2)`, chatID, e.owner); err != nil {
		t.Fatal(err)
	}
	if _, err := e.st.Pool().Exec(ctx, `UPDATE chats SET last_topic_id = 5 WHERE id = $1`, chatID); err != nil {
		t.Fatal(err)
	}
	orphan := send("topic mồ côi", 5)
	after := send("vẫn đi sau đó", 3)
	e.waitOutbox(chatID, orphan, "send", "failed")
	e.waitOutbox(chatID, after, "send", "sent")
	var reason string
	if err := e.st.Pool().QueryRow(ctx, `SELECT last_error FROM external_outbox WHERE chat_id = $1 AND seq = $2`, chatID, orphan).Scan(&reason); err != nil || reason == "" {
		t.Fatalf("reason = %q (%v), want one that says the topic is unmapped", reason, err)
	}
	if last := e.fake.Sent(); last[len(last)-1].Topic != "9" {
		t.Fatalf("the message after the refused one went into topic %q, want 9", last[len(last)-1].Topic)
	}
}
