package chat

import (
	"context"
	"testing"

	appv1 "app.local/server/gen/app/v1"
)

// TestSavedChat: the chat with yourself ("Cloud của tôi") is created once,
// pinned first, announced through the update log, reachable with
// CreatePrivate(me, me), usable like a private chat, and its pin does not
// count toward the pinned chats limit.
func TestSavedChat(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a, b := h.user("a"), h.user("b")
	other := h.group(a, b)

	saved, err := h.svc.EnsureSavedChat(ctx, a)
	if err != nil || saved == 0 {
		t.Fatalf("EnsureSavedChat = %d, %v", saved, err)
	}
	if again, err := h.svc.EnsureSavedChat(ctx, a); err != nil || again != saved {
		t.Fatalf("second EnsureSavedChat = %d, %v; want %d", again, err, saved)
	}
	chat, users, err := h.svc.CreatePrivate(ctx, a, a)
	if err != nil || chat.GetId() != saved || chat.GetType() != appv1.ChatType_CHAT_TYPE_PRIVATE || chat.GetPeerUserId() != a {
		t.Fatalf("CreatePrivate(me, me) = %v, %v", chat, err)
	}
	if len(users) != 1 || users[0].GetId() != a {
		t.Fatalf("CreatePrivate(me, me) users = %v", users)
	}

	d, pinned := h.dialogOf(a, saved)
	if d == nil || len(pinned) == 0 || pinned[0] != saved {
		t.Fatalf("saved chat dialog %v, pinned %v; want it pinned first", d, pinned)
	}
	var announced bool
	for _, u := range h.logOf(a) {
		if p := u.GetPinnedDialogs(); p != nil && len(p.GetChatIds()) > 0 && p.GetChatIds()[0] == saved {
			announced = true
		}
	}
	if !announced {
		t.Fatal("no pinned_dialogs update announced the saved chat")
	}
	if d, _ := h.dialogOf(b, saved); d != nil {
		t.Fatal("another user sees the saved chat")
	}

	h.send(a, saved, "ghi chú")
	fwd, err := h.svc.ForwardMessages(ctx, a, &appv1.ForwardMessagesRequest{FromChatId: other, ToChatId: saved, Seqs: []int64{h.send(b, other, "lưu cái này").GetMessage().GetSeq()}})
	if err != nil || len(fwd.GetMessages()) != 1 {
		t.Fatalf("forward into the saved chat = %v, %v", fwd, err)
	}

	// Five other pins still fit next to the saved chat.
	for range pinnedDialogsMax {
		if _, err := h.svc.SetDialogPinned(ctx, a, h.group(a, b), true); err != nil {
			t.Fatalf("pin with the saved chat pinned: %v", err)
		}
	}
	if _, err := h.svc.SetDialogPinned(ctx, a, saved, false); err != nil {
		t.Fatalf("unpin the saved chat: %v", err)
	}
}
