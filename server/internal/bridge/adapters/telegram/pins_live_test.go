package telegram

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/tg"
)

// TestLiveTelegramPins is the spike for pinned messages and pinned topics. It is
// for a person to run by hand and never runs on its own:
//
//	BRIDGE_LIVE_PINS=1 BRIDGE_LIVE_DIR=/some/dir TELEGRAM_API_ID=… TELEGRAM_API_HASH=… \
//	  go test ./internal/bridge/adapters/telegram -run LiveTelegramPins -timeout 20m -v
//
// BRIDGE_LIVE_DIR holds the files phone, otp and pw like TestLiveTelegramSend.
// It always reads: how many messages each forum and some other conversations have
// pinned (by the pinned filter and by the Pinned flag of the history), and which
// topics are pinned. Optional, for the parts that need a person:
//
//	BRIDGE_LIVE_PINS_WATCH=5m          log, for that long, the kind of every pin update
//	                                   (pin and unpin by hand in Telegram meanwhile)
//	BRIDGE_LIVE_PINS_SEND=<conv>/<id>  pin the message, check it, unpin it
//	BRIDGE_LIVE_PINS_TOPIC=<conv>/<id> pin the topic, check it, unpin it
//
// Only counts and ids are printed, never a title or a message.
func TestLiveTelegramPins(t *testing.T) {
	if os.Getenv("BRIDGE_LIVE_PINS") == "" {
		t.Skip("set BRIDGE_LIVE_PINS=1 to run against a real Telegram account")
	}
	dir := os.Getenv("BRIDGE_LIVE_DIR")
	apiID, _ := strconv.Atoi(os.Getenv("TELEGRAM_API_ID"))
	if dir == "" || apiID == 0 || os.Getenv("TELEGRAM_API_HASH") == "" {
		t.Fatal("BRIDGE_LIVE_DIR, TELEGRAM_API_ID and TELEGRAM_API_HASH are required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 18*time.Minute)
	defer cancel()
	a := New(Config{APIID: apiID, APIHash: os.Getenv("TELEGRAM_API_HASH")})
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
	acct := bridge.Account{ID: "live-pins", Session: step.Session}
	t.Cleanup(func() {
		c2, cancel2 := context.WithTimeout(context.Background(), time.Minute)
		defer cancel2()
		t.Logf("logout err=%v", a.Logout(c2, acct))
	})

	convs, err := a.ListConversations(ctx, acct)
	if err != nil {
		t.Fatal(err)
	}
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	api := c.live.api()

	// pinnedBy counts pinned messages of a peer two ways, which must agree: the
	// pinned filter, and the Pinned flag of the newest messages of the history.
	pinnedBy := func(peer tg.InputPeerClass) (byFilter, byFlag []int) {
		res, err := api.MessagesSearch(ctx, &tg.MessagesSearchRequest{Peer: peer, Filter: &tg.InputMessagesFilterPinned{}, Limit: 100})
		if err != nil {
			t.Logf("  search pinned: %v", err)
			return nil, nil
		}
		for _, m := range messagesOf(res) {
			byFilter = append(byFilter, m.ID)
		}
		hist, err := api.MessagesGetHistory(ctx, &tg.MessagesGetHistoryRequest{Peer: peer, Limit: 100})
		if err != nil {
			t.Logf("  history: %v", err)
			return byFilter, nil
		}
		for _, m := range messagesOf(hist) {
			if m.Pinned {
				byFlag = append(byFlag, m.ID)
			}
		}
		return byFilter, byFlag
	}

	checked := 0
	for _, cv := range convs {
		if !cv.Forum && checked >= 12 {
			continue
		}
		peer, err := c.inputPeer(ctx, cv.ID)
		if err != nil {
			continue
		}
		checked++
		filter, flag := pinnedBy(peer)
		t.Logf("%s forum=%v: %d pinned by filter %v, %d of the newest 100 carry the Pinned flag %v", cv.ID, cv.Forum, len(filter), filter, len(flag), flag)
		if cv.Forum {
			topics, err := a.ListTopics(ctx, acct, cv.ID)
			if err != nil {
				t.Logf("  topics: %v", err)
				continue
			}
			var pinned []string
			for _, tp := range topics {
				if tp.Pinned {
					pinned = append(pinned, tp.ID)
				}
			}
			t.Logf("  %d topics, pinned topics in the order listed: %v", len(topics), pinned)
			if len(topics) > 0 {
				// A topic's own pins: the search takes the topic as TopMsgID.
				top, _ := strconv.Atoi(topics[0].ID)
				res, err := api.MessagesSearch(ctx, &tg.MessagesSearchRequest{Peer: peer, Filter: &tg.InputMessagesFilterPinned{}, TopMsgID: top, Limit: 100})
				if err != nil {
					t.Logf("  pinned in topic %d: %v", top, err)
				} else {
					t.Logf("  pinned in topic %d: %d (a forum keeps one pin list for the whole group, so the topic filter shows which of them belong to the topic)", top, len(messagesOf(res)))
				}
			}
		}
	}

	if d := os.Getenv("BRIDGE_LIVE_PINS_WATCH"); d != "" {
		wait, err := time.ParseDuration(d)
		if err != nil {
			t.Fatal(err)
		}
		c.setManager(telegram.UpdateHandlerFunc(func(_ context.Context, u tg.UpdatesClass) error {
			var list []tg.UpdateClass
			switch v := u.(type) {
			case *tg.Updates:
				list = v.Updates
			case *tg.UpdatesCombined:
				list = v.Updates
			case *tg.UpdateShort:
				list = []tg.UpdateClass{v.Update}
			}
			for _, up := range list {
				switch v := up.(type) {
				case *tg.UpdatePinnedMessages:
					t.Logf("UpdatePinnedMessages pinned=%v peer=%T messages=%v", v.Pinned, v.Peer, v.Messages)
				case *tg.UpdatePinnedChannelMessages:
					t.Logf("UpdatePinnedChannelMessages pinned=%v channel=%d messages=%v", v.Pinned, v.ChannelID, v.Messages)
				case *tg.UpdatePinnedForumTopic:
					t.Logf("UpdatePinnedForumTopic pinned=%v topic=%d", v.Pinned, v.TopicID)
				case *tg.UpdatePinnedForumTopics:
					t.Logf("UpdatePinnedForumTopics order=%v", v.Order)
				case *tg.UpdateNewChannelMessage, *tg.UpdateNewMessage:
					if m, ok := messageOf(v); ok {
						if s, ok := m.(*tg.MessageService); ok {
							if _, pin := s.Action.(*tg.MessageActionPinMessage); pin {
								t.Logf("service message: pinned-message action (id %d)", s.ID)
							}
						}
					}
				}
			}
			return nil
		}))
		t.Logf("watching pin updates for %s: pin and unpin messages and topics in Telegram now", wait)
		select {
		case <-time.After(wait):
		case <-ctx.Done():
		}
		c.setManager(nil)
	}

	if target := os.Getenv("BRIDGE_LIVE_PINS_SEND"); target != "" {
		conv, idText, _ := strings.Cut(target, "/")
		id, _ := strconv.Atoi(idText)
		peer, err := c.inputPeer(ctx, conv)
		if err != nil || id == 0 {
			t.Fatalf("BRIDGE_LIVE_PINS_SEND wants <conversation>/<message id>: %v", err)
		}
		_, err = api.MessagesUpdatePinnedMessage(ctx, &tg.MessagesUpdatePinnedMessageRequest{Peer: peer, ID: id, Silent: true})
		t.Logf("pin message %d: err=%v", id, translate(err))
		filter, _ := pinnedBy(peer)
		t.Logf("  pinned now: %v", filter)
		_, err = api.MessagesUpdatePinnedMessage(ctx, &tg.MessagesUpdatePinnedMessageRequest{Peer: peer, ID: id, Unpin: true, Silent: true})
		t.Logf("unpin message %d: err=%v", id, translate(err))
		filter, _ = pinnedBy(peer)
		t.Logf("  pinned now: %v", filter)
		_, err = api.MessagesUpdatePinnedMessage(ctx, &tg.MessagesUpdatePinnedMessageRequest{Peer: peer, ID: id, Unpin: true, Silent: true})
		t.Logf("unpin it again: err=%v", translate(err))
	}

	if target := os.Getenv("BRIDGE_LIVE_PINS_TOPIC"); target != "" {
		conv, idText, _ := strings.Cut(target, "/")
		id, _ := strconv.Atoi(idText)
		peer, err := c.inputPeer(ctx, conv)
		if err != nil || id == 0 {
			t.Fatalf("BRIDGE_LIVE_PINS_TOPIC wants <conversation>/<topic id>: %v", err)
		}
		order := func(label string) {
			topics, err := a.ListTopics(ctx, acct, conv)
			if err != nil {
				t.Logf("%s: %v", label, err)
				return
			}
			var pinned []string
			for _, tp := range topics {
				if tp.Pinned {
					pinned = append(pinned, tp.ID)
				}
			}
			t.Logf("%s: pinned topics %v", label, pinned)
		}
		order("before")
		_, err = api.MessagesUpdatePinnedForumTopic(ctx, &tg.MessagesUpdatePinnedForumTopicRequest{Peer: peer, TopicID: id, Pinned: true})
		t.Logf("pin topic %d: err=%v", id, translate(err))
		order("after pin")
		_, err = api.MessagesUpdatePinnedForumTopic(ctx, &tg.MessagesUpdatePinnedForumTopicRequest{Peer: peer, TopicID: id, Pinned: false})
		t.Logf("unpin topic %d: err=%v", id, translate(err))
		order("after unpin")
	}
}

// messagesOf lists the messages of a search or history result.
func messagesOf(res tg.MessagesMessagesClass) []*tg.Message {
	var raw []tg.MessageClass
	switch v := res.(type) {
	case *tg.MessagesMessages:
		raw = v.Messages
	case *tg.MessagesMessagesSlice:
		raw = v.Messages
	case *tg.MessagesChannelMessages:
		raw = v.Messages
	}
	var out []*tg.Message
	for _, m := range raw {
		if mm, ok := m.(*tg.Message); ok {
			out = append(out, mm)
		}
	}
	return out
}

func messageOf(u tg.UpdateClass) (tg.MessageClass, bool) {
	switch v := u.(type) {
	case *tg.UpdateNewChannelMessage:
		return v.Message, true
	case *tg.UpdateNewMessage:
		return v.Message, true
	}
	return nil, false
}
