package chat

import (
	"context"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"connectrpc.com/connect"
)

func historyOf(t *testing.T, h *harness, me, chatID int64) map[int64]*appv1.Message {
	t.Helper()
	resp, err := h.svc.GetHistory(context.Background(), me, &appv1.GetHistoryRequest{ChatId: chatID, Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	out := map[int64]*appv1.Message{}
	for _, m := range resp.GetMessages() {
		out[m.GetSeq()] = m
	}
	return out
}

func TestRecalledMessagesKeepAPlaceholder(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	alice, bob, late := h.user("alice"), h.user("bob"), h.user("late")
	chatID := h.group(alice, bob)
	recalled := h.send(alice, chatID, "secret plan").GetMessage().GetSeq()
	kept := h.send(alice, chatID, "still here").GetMessage().GetSeq()
	if _, err := h.svc.SetReaction(ctx, bob, chatID, recalled, "👍"); err != nil {
		t.Fatal(err)
	}
	before, _ := h.dialogOf(bob, chatID)
	if _, err := h.svc.DeleteMessages(ctx, alice, chatID, []int64{recalled}, true); err != nil {
		t.Fatal(err)
	}

	// History keeps the place with no content, for every member.
	for _, viewer := range []int64{alice, bob} {
		got := historyOf(t, h, viewer, chatID)[recalled]
		if got == nil || !got.GetRecalled() || got.GetText() != "" || got.GetFromId() != alice || got.GetDate() == 0 ||
			len(got.GetReactions()) != 0 || len(got.GetEntities()) != 0 {
			t.Fatalf("placeholder for %d = %v", viewer, got)
		}
		if live := historyOf(t, h, viewer, chatID)[kept]; live.GetRecalled() || live.GetText() != "still here" {
			t.Fatalf("live message = %v", live)
		}
	}
	// It no longer counts as unread.
	if d, _ := h.dialogOf(bob, chatID); d.GetUnreadCount() != before.GetUnreadCount()-1 {
		t.Fatalf("unread %d before recall, %d after", before.GetUnreadCount(), d.GetUnreadCount())
	}
	// Members learn it as a recall, from the log and in realtime.
	tail := h.logOf(bob)
	del := tail[len(tail)-1].GetMessageDelete()
	if del == nil || !del.GetRecalled() || len(del.GetSeqs()) != 1 || del.GetSeqs()[0] != recalled {
		t.Fatalf("log tail = %v", tail[len(tail)-1])
	}
	h.drain()
	found := false
	for _, u := range h.sink.updatesOf(bob) {
		if d := u.GetMessageDelete(); d != nil && d.GetRecalled() {
			found = true
		}
	}
	if !found {
		t.Fatal("no realtime recall")
	}

	// Nothing can be done with the placeholder.
	if _, err := h.svc.EditMessage(ctx, alice, &appv1.EditMessageRequest{ChatId: chatID, Seq: recalled, Text: "again"}); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("edit recalled: %v", err)
	}
	if _, err := h.svc.SetReaction(ctx, bob, chatID, recalled, "❤️"); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("react to recalled: %v", err)
	}
	if _, err := h.svc.PinMessage(ctx, alice, chatID, recalled); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("pin recalled: %v", err)
	}
	if _, err := h.svc.SendMessage(ctx, bob, &appv1.SendMessageRequest{ChatId: chatID, Text: "re", ReplyToSeq: recalled}); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("reply to recalled: %v", err)
	}

	// Deleting for oneself removes the row instead (no placeholder).
	if _, err := h.svc.DeleteMessages(ctx, bob, chatID, []int64{kept}, false); err != nil {
		t.Fatal(err)
	}
	if _, ok := historyOf(t, h, bob, chatID)[kept]; ok {
		t.Fatal("hidden message still in history")
	}
	if _, ok := historyOf(t, h, alice, chatID)[kept]; !ok {
		t.Fatal("hiding removed the message for the author")
	}

	// A recalled newest message is the dialog's top, as its placeholder.
	top := h.send(bob, chatID, "oops").GetMessage().GetSeq()
	if _, err := h.svc.DeleteMessages(ctx, bob, chatID, []int64{top}, true); err != nil {
		t.Fatal(err)
	}
	dialogs, err := h.svc.GetDialogs(ctx, alice, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	var topMsg *appv1.Message
	for _, m := range dialogs.GetMessages() {
		if m.GetChatId() == chatID {
			topMsg = m
		}
	}
	if d, _ := h.dialogOf(alice, chatID); d.GetTopSeq() != top || !topMsg.GetRecalled() || topMsg.GetText() != "" {
		t.Fatalf("dialog top = %v / %v", d, topMsg)
	}

	// Placeholders follow history visibility: a later member does not see
	// earlier ones.
	if _, err := h.svc.SetHistoryVisibility(ctx, alice, chatID, appv1.HistoryVisibility_HISTORY_VISIBILITY_SINCE_JOIN); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.AddMembers(ctx, alice, chatID, []int64{late}); err != nil {
		t.Fatal(err)
	}
	for seq, m := range historyOf(t, h, late, chatID) {
		if m.GetRecalled() {
			t.Fatalf("late member sees placeholder %d", seq)
		}
	}
}

func TestRecallStaysHiddenForThoseWhoHidIt(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	alice, bob := h.user("alice"), h.user("bob")
	chatID := h.group(alice, bob)
	seq := h.send(alice, chatID, "hello").GetMessage().GetSeq()
	if _, err := h.svc.DeleteMessages(ctx, bob, chatID, []int64{seq}, false); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.DeleteMessages(ctx, alice, chatID, []int64{seq}, true); err != nil {
		t.Fatal(err)
	}
	if _, ok := historyOf(t, h, bob, chatID)[seq]; ok {
		t.Fatal("a message hidden for me came back as a placeholder")
	}
	if m := historyOf(t, h, alice, chatID)[seq]; !m.GetRecalled() {
		t.Fatalf("author's placeholder = %v", m)
	}
}
