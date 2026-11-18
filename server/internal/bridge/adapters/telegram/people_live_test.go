package telegram

import (
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gotd/td/tg"

	"app.local/server/internal/bridge"
)

// TestLiveTelegramPeople tries what Chat does to people and groups on a group made only for
// this test, through the adapter as the engine calls it: invite links, removing and adding
// back a member, promoting and demoting, marking read, a restriction that a basic group
// refuses. By hand, never on its own:
//
//	BRIDGE_LIVE_PEOPLE=<part of the group title> BRIDGE_LIVE_DIR=/some/dir TELEGRAM_API_ID=… \
//	  TELEGRAM_API_HASH=… go test ./internal/bridge/adapters/telegram -run LiveTelegramPeople -timeout 15m -v
//
// With BRIDGE_LIVE_PEOPLE_LEAVE=1 it ends by leaving the group (final).
func TestLiveTelegramPeople(t *testing.T) {
	want := os.Getenv("BRIDGE_LIVE_PEOPLE")
	if want == "" {
		t.Skip("set BRIDGE_LIVE_PEOPLE to the title of a test group to run against a real Telegram account")
	}
	ctx, a, acct := liveSession(t, "live-people", 14*time.Minute)
	convs, err := a.ListConversations(ctx, acct)
	if err != nil {
		t.Fatal(err)
	}
	var conv string
	for _, c := range convs {
		if strings.Contains(c.Title, want) && c.Kind == bridge.ConvGroup {
			conv = c.ID
			t.Logf("group %s kind=%s", c.ID, c.Kind)
		}
	}
	if conv == "" {
		t.Fatalf("no group with %q in its title", want)
	}
	step := func(name string, err error) bool {
		t.Helper()
		if err != nil {
			t.Logf("%-30s ERR %v", name, err)
			return false
		}
		t.Logf("%-30s ok", name)
		return true
	}

	// invite links
	before, err := a.ListInvites(ctx, acct, conv)
	step("list invites", err)
	t.Logf("links before: %d", len(before))
	link, err := a.CreateInvite(ctx, acct, conv, "bridge live test")
	if step("create invite", err) {
		after, err := a.ListInvites(ctx, acct, conv)
		step("list invites again", err)
		found := false
		for _, l := range after {
			if l.Link == link.Link {
				found = true
			}
		}
		t.Logf("new link listed: %v", found)
		step("revoke invite", a.RevokeInvite(ctx, acct, conv, link.Link))
		step("revoke again (idempotent)", a.RevokeInvite(ctx, acct, conv, link.Link))
	}

	// members: take the first other person, or bot, of the group
	members, complete, err := a.ListMembers(ctx, acct, conv)
	step("list members", err)
	t.Logf("members listed: %d complete=%v", len(members), complete)
	for _, m := range members {
		t.Logf("  member id=%s bot=%v admin=%v perms=%v", m.Participant.ID, m.Participant.IsBot, m.Admin, m.Perms != nil)
	}
	if len(members) > 0 {
		target := members[0].Participant.ID
		step("promote", a.SetMemberAdmin(ctx, acct, conv, target, true))
		step("promote again (idempotent)", a.SetMemberAdmin(ctx, acct, conv, target, true))
		step("demote", a.SetMemberAdmin(ctx, acct, conv, target, false))
		step("restrict (basic group refuses)", a.SetMemberPerms(ctx, acct, conv, target, bridge.Perms{Send: true}))
		if step("remove", a.RemoveMember(ctx, acct, conv, target)) {
			step("remove again (idempotent)", a.RemoveMember(ctx, acct, conv, target))
			step("add back", a.AddMember(ctx, acct, conv, target))
			after, _, err := a.ListMembers(ctx, acct, conv)
			step("list members after", err)
			t.Logf("members after: %d", len(after))
		}
	}

	// mark read up to the newest message
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		t.Fatal(err)
	}
	peer, err := c.inputPeer(ctx, conv)
	if err == nil {
		res, herr := c.live.api().MessagesGetHistory(ctx, &tg.MessagesGetHistoryRequest{Peer: peer, Limit: 1})
		if herr == nil {
			if m, ok := res.(interface{ GetMessages() []tg.MessageClass }); ok {
				for _, raw := range m.GetMessages() {
					if msg, ok := raw.(*tg.Message); ok {
						step("mark read", a.MarkRead(ctx, acct, conv, strconv.Itoa(msg.ID)))
					}
				}
			}
		} else {
			step("history", herr)
		}
	}
	release()

	if os.Getenv("BRIDGE_LIVE_PEOPLE_LEAVE") == "1" {
		step("leave group", a.LeaveGroup(ctx, acct, conv))
	}
}
