package chat

import (
	"context"
	"slices"
	"sync"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"connectrpc.com/connect"
)

// fakePresence is a fixed set of online users.
type fakePresence struct {
	mu     sync.Mutex
	online []int64
}

func (p *fakePresence) Online(userID int64) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Contains(p.online, userID)
}

func (p *fakePresence) OnlineUsers() []int64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.online)
}

func (h *harness) onlineCount(me, chatID int64) int32 {
	h.t.Helper()
	h.svc.onlineMu.Lock()
	clear(h.svc.onlineCounts)
	h.svc.onlineMu.Unlock()
	n, err := h.svc.GetChatOnlineCount(context.Background(), me, chatID)
	if err != nil {
		h.t.Fatal(err)
	}
	return n
}

func TestChatOnlineCount(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	viewer, open, hidden, contactsOnly, blocker, offline, outsider := h.user("viewer"), h.user("open"), h.user("hidden"),
		h.user("contacts"), h.user("blocker"), h.user("offline"), h.user("outsider")
	chatID := h.group(viewer, open, hidden, contactsOnly, blocker, offline)

	// Without a gateway nobody is online.
	if n := h.onlineCount(viewer, chatID); n != 0 {
		t.Fatalf("no presence = %d", n)
	}
	presence := &fakePresence{online: []int64{viewer, open, hidden, contactsOnly, blocker, outsider}}
	h.svc.SetRealtime(h.sink, presence)

	everyone, nobody := appv1.PrivacyAudience_PRIVACY_AUDIENCE_EVERYONE, appv1.PrivacyAudience_PRIVACY_AUDIENCE_NOBODY
	for user, audience := range map[int64]appv1.PrivacyAudience{open: everyone, hidden: nobody, blocker: everyone} {
		if _, err := h.svc.SetPrivacy(ctx, user, &appv1.SetPrivacyRequest{LastSeen: &audience}); err != nil {
			t.Fatal(err)
		}
	}
	if err := h.svc.Block(ctx, blocker, viewer); err != nil {
		t.Fatal(err)
	}
	// Counted: the viewer and "open". Not: hidden (nobody), contacts-only
	// without the viewer in their list, the user who blocked the viewer,
	// the offline member and the online non-member.
	if n := h.onlineCount(viewer, chatID); n != 2 {
		t.Fatalf("online = %d", n)
	}
	if _, err := h.svc.AddContact(ctx, contactsOnly, &appv1.AddContactRequest{Target: &appv1.AddContactRequest_UserId{UserId: viewer}}); err != nil {
		t.Fatal(err)
	}
	if n := h.onlineCount(viewer, chatID); n != 3 {
		t.Fatalf("online after contact = %d", n)
	}
	// Another viewer gets their own count: themselves and "blocker" (shared
	// with everyone, and it blocked someone else).
	if n := h.onlineCount(open, chatID); n != 2 {
		t.Fatalf("online for open = %d", n)
	}

	// The count is cached briefly per viewer.
	n1, err := h.svc.GetChatOnlineCount(ctx, viewer, chatID)
	if err != nil {
		t.Fatal(err)
	}
	presence.mu.Lock()
	presence.online = nil
	presence.mu.Unlock()
	if n2, _ := h.svc.GetChatOnlineCount(ctx, viewer, chatID); n2 != n1 {
		t.Fatalf("cached %d, then %d", n1, n2)
	}
	if n := h.onlineCount(viewer, chatID); n != 0 {
		t.Fatalf("after everyone left = %d", n)
	}

	// Authorization: members only; groups and (for admins) channels.
	if _, err := h.svc.GetChatOnlineCount(ctx, outsider, chatID); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("outsider: %v", err)
	}
	private, _, err := h.svc.CreatePrivate(ctx, viewer, open)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.GetChatOnlineCount(ctx, viewer, private.GetId()); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("private chat: %v", err)
	}
	channel, err := h.svc.CreateChannel(ctx, viewer, "news", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.AddMembers(ctx, viewer, channel.GetChat().GetId(), []int64{open}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.GetChatOnlineCount(ctx, open, channel.GetChat().GetId()); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("channel subscriber: %v", err)
	}
	if _, err := h.svc.GetChatOnlineCount(ctx, viewer, channel.GetChat().GetId()); err != nil {
		t.Fatalf("channel owner: %v", err)
	}
}
