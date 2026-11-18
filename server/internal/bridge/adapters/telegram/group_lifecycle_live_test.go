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

// TestLiveTelegramLeaveGroup leaves one group that still exists, through the adapter as the
// engine calls it, and looks that it is gone from the list afterwards. Leaving is final:
// the account is back in only if someone invites it. By hand, never on its own:
//
//	BRIDGE_LIVE_LEAVE=<exact title of the group> BRIDGE_LIVE_DIR=/some/dir TELEGRAM_API_ID=… \
//	  TELEGRAM_API_HASH=… go test ./internal/bridge/adapters/telegram -run LiveTelegramLeaveGroup -timeout 15m -v
func TestLiveTelegramLeaveGroup(t *testing.T) {
	want := os.Getenv("BRIDGE_LIVE_LEAVE")
	if want == "" {
		t.Skip("set BRIDGE_LIVE_LEAVE to the exact title of a group to leave it on a real Telegram account")
	}
	ctx, a, acct := liveSession(t, "live-leave", 14*time.Minute)
	convs, err := a.ListConversations(ctx, acct)
	if err != nil {
		t.Fatal(err)
	}
	var conv string
	for _, c := range convs {
		if c.Title == want && c.Kind == bridge.ConvGroup {
			if conv != "" {
				t.Fatalf("more than one group titled %q, refusing to pick one", want)
			}
			conv = c.ID
		}
	}
	if conv == "" {
		t.Fatalf("no group titled exactly %q", want)
	}
	t.Logf("group %s", conv)

	if err := a.LeaveGroup(ctx, acct, conv); err != nil {
		t.Fatalf("leave group: %v", err)
	}
	t.Log("leave group                    ok")
	after, err := a.ListConversations(ctx, acct)
	if err != nil {
		t.Fatal(err)
	}
	listed := false
	for _, c := range after {
		listed = listed || c.ID == conv
	}
	t.Logf("groups listed before %d, after %d; the group is still listed: %v", len(convs), len(after), listed)

	// A basic group the account left stays in the dialog list, marked as left; only a
	// channel or supergroup drops out. So what proves the leaving is the flag, not the list.
	if id, ok := strings.CutPrefix(conv, "chat:"); ok {
		chatID, err := strconv.ParseInt(id, 10, 64)
		if err != nil {
			t.Fatal(err)
		}
		c, release, err := a.acquire(ctx, acct)
		if err != nil {
			t.Fatal(err)
		}
		res, err := c.live.api().MessagesGetChats(ctx, []int64{chatID})
		release()
		if err != nil {
			t.Fatal(err)
		}
		left := false
		for _, raw := range res.GetChats() {
			switch ch := raw.(type) {
			case *tg.Chat:
				left = ch.Left
				t.Logf("telegram says: left=%v deactivated=%v members=%d", ch.Left, ch.Deactivated, ch.ParticipantsCount)
			case *tg.ChatForbidden:
				left = true
				t.Logf("telegram says: forbidden (%s)", ch.Title)
			}
		}
		if !left {
			t.Errorf("the account is not marked as having left %s", conv)
		}
	} else if listed {
		t.Errorf("the group %s is still listed after leaving", conv)
	}
	// leaving again: the call may be throttled, so the answer is only recorded
	t.Logf("leave again                    err=%v", a.LeaveGroup(ctx, acct, conv))
}

// TestLiveTelegramLeaveGone leaves a conversation that is no longer in the account's dialogs
// (one it left or that was deleted) and wants that to be done, not an error. By hand:
//
//	BRIDGE_LIVE_GONE=<id of the conversation, e.g. channel:123> BRIDGE_LIVE_DIR=/some/dir … \
//	  go test ./internal/bridge/adapters/telegram -run LiveTelegramLeaveGone -timeout 15m -v
func TestLiveTelegramLeaveGone(t *testing.T) {
	conv := os.Getenv("BRIDGE_LIVE_GONE")
	if conv == "" {
		t.Skip("set BRIDGE_LIVE_GONE to the id of a conversation the account is no longer in")
	}
	ctx, a, acct := liveSession(t, "live-gone", 14*time.Minute)
	convs, err := a.ListConversations(ctx, acct)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range convs {
		if c.ID == conv {
			t.Fatalf("%s (%q) is still in the dialogs; this test is only for one that is not", conv, c.Title)
		}
	}
	if err := a.LeaveGroup(ctx, acct, conv); err != nil {
		t.Fatalf("leaving a conversation that is gone = %v, want done", err)
	}
	t.Log("leave a conversation that is gone  ok")
}

// TestLiveTelegramGroupLifecycle deletes, then tries to leave, a basic group made only for
// this test, through the adapter as the engine calls it. It cannot be undone: the group is
// gone for everyone. By hand, never on its own:
//
//	BRIDGE_LIVE_LIFECYCLE=<exact title of the group> BRIDGE_LIVE_DIR=/some/dir TELEGRAM_API_ID=… \
//	  TELEGRAM_API_HASH=… go test ./internal/bridge/adapters/telegram -run LiveTelegramGroupLifecycle -timeout 15m -v
//
// The title must match exactly and the group must be a basic group, so that a supergroup is
// never touched; Telegram itself refuses the delete when the account is not the creator.
// Deleting comes first because a creator who has left can no longer delete.
func TestLiveTelegramGroupLifecycle(t *testing.T) {
	want := os.Getenv("BRIDGE_LIVE_LIFECYCLE")
	if want == "" {
		t.Skip("set BRIDGE_LIVE_LIFECYCLE to the exact title of a basic test group to delete it on a real Telegram account")
	}
	ctx, a, acct := liveSession(t, "live-lifecycle", 14*time.Minute)
	convs, err := a.ListConversations(ctx, acct)
	if err != nil {
		t.Fatal(err)
	}
	var conv string
	for _, c := range convs {
		if c.Title == want && c.Kind == bridge.ConvGroup && strings.HasPrefix(c.ID, "chat:") {
			if conv != "" {
				t.Fatalf("more than one basic group titled %q, refusing to pick one", want)
			}
			conv = c.ID
		}
	}
	if conv == "" {
		t.Fatalf("no basic group titled exactly %q", want)
	}
	t.Logf("group %s", conv)

	err = a.DeleteGroup(ctx, acct, conv)
	t.Logf("delete group                   err=%v", err)
	if err != nil {
		t.Fatalf("the group was not deleted: %v", err)
	}
	// what Chat sees afterwards: the group is no longer listed
	after, err := a.ListConversations(ctx, acct)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range after {
		if c.ID == conv {
			t.Errorf("the deleted group %s is still listed (title %q)", conv, c.Title)
		}
	}
	t.Logf("groups listed before %d, after %d", len(convs), len(after))
	// leaving what is already gone: recorded, not asserted
	t.Logf("leave the deleted group        err=%v", a.LeaveGroup(ctx, acct, conv))
}
