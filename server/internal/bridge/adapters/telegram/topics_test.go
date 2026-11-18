package telegram

import (
	"context"
	"errors"
	"strconv"
	"testing"
	"time"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
)

func header(forum bool, msgID, topID int) *tg.MessageReplyHeader {
	h := &tg.MessageReplyHeader{ForumTopic: forum}
	if msgID != 0 {
		h.SetReplyToMsgID(msgID)
	}
	if topID != 0 {
		h.SetReplyToTopID(topID)
	}
	return h
}

func forumBook() *peerBook {
	b := newPeerBook()
	b.add([]tg.UserClass{&tg.User{ID: 7, FirstName: "Lan"}}, []tg.ChatClass{
		&tg.Channel{ID: 500, Title: "Diễn đàn", Megagroup: true, Forum: true},
		&tg.Channel{ID: 501, Title: "Nhóm thường", Megagroup: true},
		&tg.Channel{ID: 502, Title: "Kênh", Broadcast: true},
	})
	return b
}

func forumMessage(id int, peer int64, h tg.MessageReplyHeaderClass) *tg.Message {
	m := &tg.Message{ID: id, PeerID: &tg.PeerChannel{ChannelID: peer}, FromID: &tg.PeerUser{UserID: 7}, Date: 1_700_000_000, Message: "x"}
	if h != nil {
		m.SetReplyTo(h)
	}
	return m
}

func TestTopicOfFollowsTheRuleCheckedAgainstTelegram(t *testing.T) {
	cases := []struct {
		name string
		h    tg.MessageReplyHeaderClass
		want string
	}{
		{"no header is General", nil, "1"},
		{"forum flag without top id: posted in topic ReplyToMsgID", header(true, 7, 0), "7"},
		{"forum flag with top id: a reply inside topic ReplyToTopID", header(true, 120, 7), "7"},
		{"a header without the forum flag is General", header(false, 55, 0), "1"},
		{"a header with nothing is General", header(true, 0, 0), "1"},
	}
	for _, c := range cases {
		if got := topicOf(forumMessage(9, 500, c.h)); got != c.want {
			t.Errorf("%s = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestAMessageOfAForumHasATopicAndNoFalseReplyToItsTopic(t *testing.T) {
	b := forumBook()
	in, ok := b.mapMessage(forumMessage(9, 500, header(true, 7, 0)), selfID)
	if !ok || in.Topic != "7" || in.ReplyTo != "" {
		t.Fatalf("posted in topic 7 = %+v: want topic 7 and no reply (the header only names the topic)", in)
	}
	in, _ = b.mapMessage(forumMessage(10, 500, header(true, 120, 7)), selfID)
	if in.Topic != "7" || in.ReplyTo != "120" {
		t.Fatalf("a reply inside topic 7 = topic %q reply %q, want 7 and 120", in.Topic, in.ReplyTo)
	}
	in, _ = b.mapMessage(forumMessage(11, 500, nil), selfID)
	if in.Topic != "1" || in.ReplyTo != "" {
		t.Fatalf("a message with no header = topic %q reply %q, want General and no reply", in.Topic, in.ReplyTo)
	}
	// A group that is not a forum is unchanged: no topic, replies as before.
	in, _ = b.mapMessage(forumMessage(12, 501, header(false, 55, 0)), selfID)
	if in.Topic != "" || in.ReplyTo != "55" {
		t.Fatalf("a message of an ordinary group = topic %q reply %q, want none and 55", in.Topic, in.ReplyTo)
	}
	in, _ = b.mapMessage(forumMessage(13, 502, nil), selfID)
	if in.Topic != "" {
		t.Fatalf("a channel post has topic %q, want none", in.Topic)
	}
}

func TestOnlyASupergroupWithTopicsIsAForumConversation(t *testing.T) {
	b := forumBook()
	for id, want := range map[int64]bool{500: true, 501: false, 502: false} {
		conv, ok := b.conversationOf(&tg.PeerChannel{ChannelID: id}, selfID)
		if !ok || conv.Forum != want {
			t.Errorf("channel %d: forum = %v (ok %v), want %v", id, conv.Forum, ok, want)
		}
	}
}

func topicPage(from, n int) ([]tg.ForumTopicClass, []tg.MessageClass) {
	var topics []tg.ForumTopicClass
	var msgs []tg.MessageClass
	for id := from; id < from+n; id++ {
		topics = append(topics, &tg.ForumTopic{ID: id, Title: "t" + strconv.Itoa(id), IconColor: 0x6FB9F0, TopMessage: id * 10, Date: 1_700_000_000 + id})
		msgs = append(msgs, &tg.Message{ID: id * 10, Date: 1_700_100_000 + id})
	}
	return topics, msgs
}

func TestAListingEndsOnAShortPageIgnoresTheCountAndTheDeletedAndAsksFromTheLastTopic(t *testing.T) {
	var requests []tg.MessagesGetForumTopicsRequest
	first, firstMsgs := topicPage(1, topicPageMax)
	second, secondMsgs := topicPage(topicPageMax+1, 3)
	second = append(second, &tg.ForumTopicDeleted{ID: 9999})
	pages := []*tg.MessagesForumTopics{
		{Topics: first, Messages: firstMsgs, Count: 5}, // Telegram's count is not trusted
		{Topics: second, Messages: secondMsgs, Count: 5},
	}
	fetch := func(req *tg.MessagesGetForumTopicsRequest) (*tg.MessagesForumTopics, error) {
		requests = append(requests, *req)
		return pages[len(requests)-1], nil
	}
	got, err := listForumTopics(context.Background(), fetch, &tg.InputPeerChannel{ChannelID: 500})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != topicPageMax+3 || len(requests) != 2 {
		t.Fatalf("%d topics in %d requests, want %d topics in 2 requests", len(got), len(requests), topicPageMax+3)
	}
	if r := requests[1]; r.OffsetTopic != topicPageMax || r.OffsetID != topicPageMax*10 || r.OffsetDate != 1_700_100_000+topicPageMax {
		t.Fatalf("second request = %+v, want it to continue after the last topic of the first page", r)
	}
	if !got[0].General || got[1].General || got[0].ID != "1" || got[1].Title != "t2" {
		t.Fatalf("first topics = %+v %+v, want topic 1 to be General", got[0], got[1])
	}
}

func TestAListingStopsOnAFailureAndOnACancelledContext(t *testing.T) {
	boom := errors.New("boom")
	if _, err := listForumTopics(context.Background(), func(*tg.MessagesGetForumTopicsRequest) (*tg.MessagesForumTopics, error) {
		return nil, boom
	}, &tg.InputPeerChannel{}); !errors.Is(err, boom) {
		t.Fatalf("a failing call = %v, want its error", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	first, msgs := topicPage(1, topicPageMax)
	calls := 0
	_, err := listForumTopics(ctx, func(*tg.MessagesGetForumTopicsRequest) (*tg.MessagesForumTopics, error) {
		calls++
		cancel()
		return &tg.MessagesForumTopics{Topics: first, Messages: msgs}, nil
	}, &tg.InputPeerChannel{})
	if !errors.Is(err, context.Canceled) || calls != 1 {
		t.Fatalf("a cancelled listing = %v after %d calls, want Canceled after 1", err, calls)
	}
}

func TestATopicOfTelegramIsMapped(t *testing.T) {
	got := forumTopic(&tg.ForumTopic{ID: 134925, Title: "Hạ tầng", IconColor: 0x6FB9F0, Closed: true, Pinned: true, Hidden: true, Date: 1_700_000_000})
	if got.ID != "134925" || got.Title != "Hạ tầng" || got.IconColor != 0x6FB9F0 || !got.Closed || !got.Pinned || !got.Hidden || got.General || !got.Created.Equal(time.Unix(1_700_000_000, 0)) {
		t.Fatalf("topic = %+v", got)
	}
	if !forumTopic(&tg.ForumTopic{ID: 1}).General {
		t.Fatal("topic 1 is General")
	}
}

func TestServiceMessagesOfTopicsAreRecognised(t *testing.T) {
	b := forumBook()
	create := &tg.MessageService{ID: 777, PeerID: &tg.PeerChannel{ChannelID: 500}, Date: 1_700_000_000, Action: &tg.MessageActionTopicCreate{Title: "Mới"}}
	if conv, topic, created, ok := b.topicAction(create); !ok || conv != "channel:500" || topic != "777" || !created {
		t.Fatalf("a topic opened = %q %q created=%v ok=%v, want the id of the service message", conv, topic, created, ok)
	}
	edit := &tg.MessageService{ID: 900, PeerID: &tg.PeerChannel{ChannelID: 500}, Action: &tg.MessageActionTopicEdit{}}
	edit.SetReplyTo(header(true, 777, 0))
	if conv, topic, created, ok := b.topicAction(edit); !ok || topic != "777" || created || conv != "channel:500" {
		t.Fatalf("a topic edited = %q %q created=%v ok=%v", conv, topic, created, ok)
	}
	withTop := &tg.MessageService{ID: 901, PeerID: &tg.PeerChannel{ChannelID: 500}, Action: &tg.MessageActionTopicEdit{}}
	withTop.SetReplyTo(header(true, 5, 777))
	if _, topic, _, ok := b.topicAction(withTop); !ok || topic != "777" {
		t.Fatalf("an edit that names the top id = %q ok=%v, want 777", topic, ok)
	}
	noHeader := &tg.MessageService{ID: 902, PeerID: &tg.PeerChannel{ChannelID: 500}, Action: &tg.MessageActionTopicEdit{}}
	if _, _, _, ok := b.topicAction(noHeader); ok {
		t.Fatal("an edit that names no topic must be ignored")
	}
	other := &tg.MessageService{ID: 903, PeerID: &tg.PeerChannel{ChannelID: 500}, Action: &tg.MessageActionPinMessage{}}
	if _, _, _, ok := b.topicAction(other); ok {
		t.Fatal("a pin is not a topic change")
	}
	notForum := &tg.MessageService{ID: 904, PeerID: &tg.PeerChannel{ChannelID: 501}, Action: &tg.MessageActionTopicCreate{Title: "x"}}
	if _, _, _, ok := b.topicAction(notForum); ok {
		t.Fatal("a group without topics has no topic events")
	}
	if _, _, _, ok := b.topicAction(forumMessage(1, 500, nil)); ok {
		t.Fatal("a plain message is not a topic change")
	}
}

func TestAMessageIsPutInATopicByTheHeaderTelegramReadsBack(t *testing.T) {
	cases := []struct {
		reply, topic string
		wantMsg      int
		wantTop      int
		wantNil      bool
	}{
		{"", "", 0, 0, true},
		{"", "1", 0, 0, true},
		{"55", "", 55, 0, false},
		{"55", "1", 55, 0, false},
		{"", "7", 7, 0, false},
		{"55", "7", 55, 7, false},
	}
	for _, c := range cases {
		got, err := topicReplyTo(c.reply, c.topic)
		if err != nil {
			t.Fatalf("(%q, %q): %v", c.reply, c.topic, err)
		}
		if c.wantNil {
			if got != nil {
				t.Errorf("(%q, %q) = %+v, want no header", c.reply, c.topic, got)
			}
			continue
		}
		h, ok := got.(*tg.InputReplyToMessage)
		if !ok || h.ReplyToMsgID != c.wantMsg || h.TopMsgID != c.wantTop {
			t.Errorf("(%q, %q) = %+v, want reply %d top %d", c.reply, c.topic, got, c.wantMsg, c.wantTop)
		}
	}
	if _, err := topicReplyTo("x", ""); err == nil {
		t.Error("a reply id that is not a number must be an error")
	}
	if _, err := topicReplyTo("", "x"); err == nil {
		t.Error("a topic id that is not a number must be an error")
	}
}

func TestASendIntoAClosedOrDeletedTopicIsRefusedForGood(t *testing.T) {
	for _, rpc := range []string{"TOPIC_CLOSED", "TOPIC_DELETED", "TOPIC_ID_INVALID"} {
		if err := translateSend(tgerr.New(400, rpc)); !errors.Is(err, bridge.ErrNotAllowed) {
			t.Errorf("%s = %v, want ErrNotAllowed", rpc, err)
		}
	}
}

func TestTheAdapterReadsTopics(t *testing.T) {
	if !New(Config{}).Capabilities().Has(bridge.CapTopics) {
		t.Fatal("the adapter implements TopicReader and must declare CapTopics")
	}
}
