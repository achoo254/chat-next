package telegram_test

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/adapters/telegram"
)

// TestLiveTelegramTopics reads the forum groups of a real account through the
// adapter: which conversations are forums, their topics, and the topic the
// adapter gives to the newest messages. It sends nothing, unless
// BRIDGE_LIVE_TOPIC_SEND names a topic to test in, as "<conversation>/<topic id>"
// (then it sends one message into that topic, edits it and deletes it). It is for
// a person to run by hand and never runs on its own:
//
//	BRIDGE_LIVE_TOPICS=1 BRIDGE_LIVE_DIR=/some/dir TELEGRAM_API_ID=… TELEGRAM_API_HASH=… \
//	  go test ./internal/bridge/adapters/telegram -run LiveTelegramTopics -timeout 15m -v
//
// BRIDGE_LIVE_DIR holds the files phone, otp and pw like TestLiveTelegramSend.
// Only counts and ids are printed, never a title or a message.
func TestLiveTelegramTopics(t *testing.T) {
	if os.Getenv("BRIDGE_LIVE_TOPICS") == "" {
		t.Skip("set BRIDGE_LIVE_TOPICS=1 to run against a real Telegram account")
	}
	dir := os.Getenv("BRIDGE_LIVE_DIR")
	apiID, _ := strconv.Atoi(os.Getenv("TELEGRAM_API_ID"))
	if dir == "" || apiID == 0 || os.Getenv("TELEGRAM_API_HASH") == "" {
		t.Fatal("BRIDGE_LIVE_DIR, TELEGRAM_API_ID and TELEGRAM_API_HASH are required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
	defer cancel()
	a := telegram.New(telegram.Config{APIID: apiID, APIHash: os.Getenv("TELEGRAM_API_HASH")})
	t.Cleanup(a.Close)

	fileValue := func(name string, wait time.Duration) string {
		deadline := time.Now().Add(wait)
		for {
			if b, err := os.ReadFile(filepath.Join(dir, name)); err == nil {
				return strings.TrimSpace(string(b))
			}
			if time.Now().After(deadline) {
				t.Fatalf("file %s never appeared in BRIDGE_LIVE_DIR", name)
			}
			time.Sleep(500 * time.Millisecond)
		}
	}
	step, err := a.Login(ctx, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	for step.Kind == bridge.StepInput {
		in := map[string]string{}
		for _, f := range step.Fields {
			switch f.Name {
			case "phone":
				in[f.Name] = fileValue("phone", time.Second)
			case "code":
				in[f.Name] = fileValue("otp", 6*time.Minute)
			case "password":
				in[f.Name] = fileValue("pw", time.Second)
			}
		}
		if step, err = a.Login(ctx, step.Token, in); err != nil {
			t.Fatal(err)
		}
	}
	if step.Kind != bridge.StepDone {
		t.Fatalf("login ended at %v", step.Kind)
	}
	acct := bridge.Account{ID: "live-topics", Session: step.Session}
	t.Cleanup(func() {
		c2, cancel2 := context.WithTimeout(context.Background(), time.Minute)
		defer cancel2()
		t.Logf("logout err=%v", a.Logout(c2, acct))
	})

	convs, err := a.ListConversations(ctx, acct)
	if err != nil {
		t.Fatal(err)
	}
	var forums []bridge.Conversation
	for _, c := range convs {
		if c.Forum {
			forums = append(forums, c)
		}
	}
	t.Logf("%d conversations, %d of them forums", len(convs), len(forums))
	if len(forums) == 0 {
		t.Fatal("no forum conversation: the adapter does not recognise forums")
	}
	for i, f := range forums {
		topics, err := a.ListTopics(ctx, acct, f.ID)
		if err != nil {
			t.Fatalf("ListTopics of forum %d: %v", i, err)
		}
		general, closed, pinned := 0, 0, 0
		listed := map[string]bool{}
		for _, tp := range topics {
			listed[tp.ID] = true
			if tp.General {
				general++
			}
			if tp.Closed {
				closed++
			}
			if tp.Pinned {
				pinned++
			}
		}
		t.Logf("forum %d (%s): %d topics, General x%d, closed %d, pinned %d", i, f.ID, len(topics), general, closed, pinned)
		if general != 1 {
			t.Errorf("forum %d lists General %d times, want once", i, general)
		}
		page, err := a.Backfill(ctx, acct, f.ID, bridge.Cursor{}, 100)
		if err != nil {
			t.Fatalf("Backfill of forum %d: %v", i, err)
		}
		byTopic := map[string]int{}
		unlisted, empty, falseReplies := 0, 0, 0
		for _, m := range page.Messages {
			if m.Topic == "" {
				empty++
				continue
			}
			byTopic[m.Topic]++
			if !listed[m.Topic] {
				unlisted++
			}
			if m.ReplyTo != "" && m.ReplyTo == m.Topic {
				falseReplies++
			}
		}
		t.Logf("forum %d: newest %d messages in %d topics; without a topic %d; in a topic that is not listed %d; replying to their own topic %d",
			i, len(page.Messages), len(byTopic), empty, unlisted, falseReplies)
		if empty != 0 || falseReplies != 0 {
			t.Errorf("forum %d: %d messages have no topic and %d reply to their own topic", i, empty, falseReplies)
		}
	}

	target := os.Getenv("BRIDGE_LIVE_TOPIC_SEND")
	if target == "" {
		t.Log("no BRIDGE_LIVE_TOPIC_SEND: nothing was sent")
		return
	}
	conv, topic, ok := strings.Cut(target, "/")
	if !ok {
		t.Fatal("BRIDGE_LIVE_TOPIC_SEND is <conversation>/<topic id>")
	}
	sender := bridge.Sender(a)
	ref, err := sender.SendMessage(ctx, acct, bridge.OutMessage{Conversation: conv, Topic: topic, Text: "[topic test] thử gửi vào topic", RandomID: 7100710071})
	if err != nil || len(ref.IDs) != 1 {
		t.Fatalf("send into the topic = %+v, %v", ref, err)
	}
	t.Cleanup(func() {
		c2, cancel2 := context.WithTimeout(context.Background(), time.Minute)
		defer cancel2()
		t.Logf("cleanup delete err=%v", sender.DeleteMessages(c2, acct, bridge.Delete{Conversation: conv, IDs: ref.IDs}))
	})
	page, err := a.Backfill(ctx, acct, conv, bridge.Cursor{}, 5)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, m := range page.Messages {
		if m.ID == ref.IDs[0] {
			found = true
			t.Logf("the message read back is in topic %q (sent into %q)", m.Topic, topic)
			if m.Topic != topic {
				t.Errorf("sent into topic %s but read back in topic %s", topic, m.Topic)
			}
		}
	}
	if !found {
		t.Error("the message sent was not among the newest messages")
	}
	if err := sender.EditMessage(ctx, acct, bridge.EditRequest{Conversation: conv, ID: ref.IDs[0], Text: "[topic test] đã sửa"}); err != nil {
		t.Errorf("edit in the topic: %v", err)
	}
}
