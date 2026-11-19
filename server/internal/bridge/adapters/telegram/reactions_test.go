package telegram

import (
	"errors"
	"fmt"
	"testing"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
)

func describeReactions(rs bridge.Reactions) string {
	out := ""
	for _, r := range rs.List {
		who := r.From.ID
		if r.From.IsSelf {
			who = "me"
		}
		out += who + "=" + r.Emoji + " "
	}
	return fmt.Sprintf("[%s] complete=%v owner=%v", out, rs.Complete, rs.OwnerKnown)
}

func emojiCount(e string, n int, chosen bool) tg.ReactionCount {
	rc := tg.ReactionCount{Reaction: &tg.ReactionEmoji{Emoticon: e}, Count: n}
	if chosen {
		rc.SetChosenOrder(0)
	}
	return rc
}

func peerReaction(user int64, e string, my bool) tg.MessagePeerReaction {
	return tg.MessagePeerReaction{PeerID: &tg.PeerUser{UserID: user}, Reaction: &tg.ReactionEmoji{Emoticon: e}, My: my}
}

func TestMapReactions(t *testing.T) {
	const self = 10
	b := newPeerBook()
	b.users[20] = &tg.User{ID: 20, FirstName: "Lan"}
	cases := []struct {
		name string
		mr   *tg.MessageReactions
		want string
	}{
		{"none", nil, "[] complete=true owner=true"},
		{"small group, everyone listed, the owner chose one",
			&tg.MessageReactions{
				Results:         []tg.ReactionCount{emojiCount("👍", 1, false), emojiCount("❤", 1, true)},
				RecentReactions: []tg.MessagePeerReaction{peerReaction(20, "👍", false), peerReaction(self, "❤", true)},
			},
			"[me=❤ 20=👍 ] complete=true owner=true"},
		{"large group lists only some",
			&tg.MessageReactions{
				Results:         []tg.ReactionCount{emojiCount("👍", 12, false)},
				RecentReactions: []tg.MessagePeerReaction{peerReaction(20, "👍", false)},
			},
			"[20=👍 ] complete=false owner=true"},
		{"a custom emoji has no counterpart, so the list is not complete",
			&tg.MessageReactions{
				Results:         []tg.ReactionCount{emojiCount("👍", 1, false), {Reaction: &tg.ReactionCustomEmoji{DocumentID: 5}, Count: 1}},
				RecentReactions: []tg.MessagePeerReaction{peerReaction(20, "👍", false)},
			},
			"[20=👍 ] complete=false owner=true"},
		{"a min answer does not tell the owner",
			&tg.MessageReactions{
				Min:             true,
				Results:         []tg.ReactionCount{emojiCount("❤", 1, true)},
				RecentReactions: []tg.MessagePeerReaction{peerReaction(self, "❤", true)},
			},
			"[] complete=false owner=false"},
		{"a premium user's second reaction is not a second person",
			&tg.MessageReactions{
				Results:         []tg.ReactionCount{emojiCount("👍", 1, false), emojiCount("🔥", 1, false)},
				RecentReactions: []tg.MessagePeerReaction{peerReaction(20, "🔥", false), peerReaction(20, "👍", false)},
			},
			"[20=🔥 ] complete=false owner=true"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := b.mapReactions("chat:1", 7, c.mr, self)
			if got.Conversation != "chat:1" || got.ID != "7" {
				t.Fatalf("names %s/%s, want chat:1/7", got.Conversation, got.ID)
			}
			if d := describeReactions(got); d != c.want {
				t.Fatalf("got %s, want %s", d, c.want)
			}
		})
	}
}

func TestReactionsOfUpdatesPicksTheReactionUpdates(t *testing.T) {
	u := &tg.Updates{
		Users: []tg.UserClass{&tg.User{ID: 20, FirstName: "Lan"}},
		Updates: []tg.UpdateClass{
			&tg.UpdateMessageReactions{Peer: &tg.PeerChat{ChatID: 3}, MsgID: 8, Reactions: tg.MessageReactions{
				Results:         []tg.ReactionCount{emojiCount("👍", 1, false)},
				RecentReactions: []tg.MessagePeerReaction{peerReaction(20, "👍", false)},
			}},
			&tg.UpdateReadHistoryInbox{},
		},
	}
	got := reactionsOfUpdates(u, 10)
	if len(got) != 1 || got[0].Conversation != prefixChat+"3" || got[0].ID != "8" || got[0].List[0].From.Name != "Lan" {
		t.Fatalf("got %+v", got)
	}
}

func TestTranslateReaction(t *testing.T) {
	if err := translateReaction(tgerr.New(400, "MESSAGE_NOT_MODIFIED")); err != nil {
		t.Fatalf("setting what is already set: %v", err)
	}
	for _, typ := range []string{"REACTION_INVALID", "PREMIUM_ACCOUNT_REQUIRED", "CHAT_WRITE_FORBIDDEN"} {
		if err := translateReaction(tgerr.New(400, typ)); !errors.Is(err, bridge.ErrNotAllowed) {
			t.Fatalf("%s: %v, want ErrNotAllowed", typ, err)
		}
	}
}
