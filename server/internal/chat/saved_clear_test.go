package chat

import (
	"context"
	"fmt"
	"slices"
	"testing"

	appv1 "app.local/server/gen/app/v1"
)

func TestClearSavedChatKeepsDialogAndPin(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	me := h.user("me")
	saved, err := h.svc.EnsureSavedChat(ctx, me)
	if err != nil {
		t.Fatal(err)
	}
	h.send(me, saved, "ghi chú bí mật zeta")
	h.send(me, saved, "ghi chú thứ hai zeta")
	if got := h.found(me, "zeta"); len(got) != 2 {
		t.Fatalf("search before clear = %v", got)
	}
	h.drain()
	before := len(h.logOf(me))
	if _, err := h.svc.DeleteChat(ctx, me, saved); err != nil {
		t.Fatal(err)
	}
	h.drain()
	// Still listed and still pinned, with nothing unread.
	d, pinned := h.dialogOf(me, saved)
	if d == nil || !slices.Contains(pinned, saved) {
		t.Fatalf("saved chat after clear: dialog %v, pinned %v", d, pinned)
	}
	if d.GetUnreadCount() != 0 {
		t.Fatalf("unread after clear = %d", d.GetUnreadCount())
	}
	// The old notes are gone from history and search.
	hist, err := h.svc.GetHistory(ctx, me, &appv1.GetHistoryRequest{ChatId: saved, Limit: 50})
	if err != nil {
		t.Fatal(err)
	}
	if n := len(hist.GetMessages()); n != 0 {
		t.Fatalf("history after clear has %d messages", n)
	}
	if got := h.found(me, "zeta"); len(got) != 0 {
		t.Fatalf("search after clear = %v", got)
	}
	// My sessions learn it in an order today's clients apply: drop the
	// history, the chat as I see it, the pins with the saved chat.
	var kinds []string
	for _, u := range h.logOf(me)[before:] {
		switch k := u.GetKind().(type) {
		case *appv1.Update_ChatDeleted:
			kinds = append(kinds, fmt.Sprintf("chat_deleted:%v", k.ChatDeleted.GetChatId() == saved && !k.ChatDeleted.GetForEveryone()))
		case *appv1.Update_ChatUpdated:
			kinds = append(kinds, fmt.Sprintf("chat_updated:%v", k.ChatUpdated.GetChat().GetId() == saved))
		case *appv1.Update_PinnedDialogs:
			kinds = append(kinds, fmt.Sprintf("pinned_dialogs:%v", slices.Contains(k.PinnedDialogs.GetChatIds(), saved)))
		default:
			kinds = append(kinds, fmt.Sprintf("%T", k))
		}
	}
	if got := fmt.Sprint(kinds); got != "[chat_deleted:true chat_updated:true pinned_dialogs:true]" {
		t.Fatalf("log after clear = %s", got)
	}
	// A new note after clearing works and is the only one.
	h.send(me, saved, "ghi chú mới zeta")
	hist, err = h.svc.GetHistory(ctx, me, &appv1.GetHistoryRequest{ChatId: saved, Limit: 50})
	if err != nil {
		t.Fatal(err)
	}
	if n := len(hist.GetMessages()); n != 1 || hist.GetMessages()[0].GetText() != "ghi chú mới zeta" {
		t.Fatalf("history after a new note = %v", hist.GetMessages())
	}
	if got := h.found(me, "zeta"); fmt.Sprint(got) != "[ghi chú mới zeta]" {
		t.Fatalf("search after a new note = %v", got)
	}
	// An unpinned saved chat stays listed too, in the same place: its sort
	// date stays the time of the newest note, with no top message.
	if _, err := h.svc.SetDialogPinned(ctx, me, saved, false); err != nil {
		t.Fatal(err)
	}
	d, _ = h.dialogOf(me, saved)
	sortDate := d.GetSortDate()
	if sortDate == 0 || d.GetTopSeq() == 0 {
		t.Fatalf("saved chat before clear: sort date %d, top %d", sortDate, d.GetTopSeq())
	}
	if _, err := h.svc.DeleteChat(ctx, me, saved); err != nil {
		t.Fatal(err)
	}
	d, pinned = h.dialogOf(me, saved)
	if d == nil || slices.Contains(pinned, saved) {
		t.Fatalf("unpinned saved chat after clear: dialog %v, pinned %v", d, pinned)
	}
	if d.GetTopSeq() != 0 || d.GetSortDate() != sortDate {
		t.Fatalf("unpinned saved chat after clear: top %d, sort date %d, want 0 and %d", d.GetTopSeq(), d.GetSortDate(), sortDate)
	}
}
