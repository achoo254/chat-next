package telegram

import (
	"os"
	"strings"
	"testing"
	"time"

	"app.local/server/internal/bridge"
)

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
