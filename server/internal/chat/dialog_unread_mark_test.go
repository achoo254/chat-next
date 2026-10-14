package chat

import (
	"context"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"connectrpc.com/connect"
)

func unreadMarks(updates []*appv1.Update) []*appv1.UpdateDialogUnreadMark {
	var out []*appv1.UpdateDialogUnreadMark
	for _, u := range updates {
		if m := u.GetDialogUnreadMark(); m != nil {
			out = append(out, m)
		}
	}
	return out
}

func TestDialogUnreadMark(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a, b, stranger := h.user("a"), h.user("b"), h.user("stranger")
	chatID := h.group(a, b)
	top := h.send(b, chatID, "hi").GetMessage().GetSeq()
	if _, err := h.svc.ReadHistory(ctx, a, chatID, top, 0); err != nil {
		t.Fatal(err)
	}

	ack, err := h.svc.SetDialogUnreadMark(ctx, a, chatID, true)
	if err != nil {
		t.Fatal(err)
	}
	if ack.GetPts() == 0 {
		t.Fatalf("ack = %v", ack)
	}
	if d, _ := h.dialogOf(a, chatID); !d.GetUnreadMark() || d.GetUnreadCount() != 0 {
		t.Fatalf("dialog = %v", d)
	}
	if d, _ := h.dialogOf(b, chatID); d.GetUnreadMark() {
		t.Fatalf("other member marked: %v", d)
	}
	// My other sessions learn it from the log and in realtime; nobody else.
	if got := unreadMarks(h.logOf(a)); len(got) != 1 || got[0].GetChatId() != chatID || !got[0].GetUnread() {
		t.Fatalf("log = %v", got)
	}
	h.drain()
	if got := unreadMarks(h.sink.updatesOf(a)); len(got) != 1 || !got[0].GetUnread() {
		t.Fatalf("realtime = %v", got)
	}
	if got := unreadMarks(h.sink.updatesOf(b)); len(got) != 0 {
		t.Fatalf("other member got %v", got)
	}

	// Setting it again writes nothing.
	if again, err := h.svc.SetDialogUnreadMark(ctx, a, chatID, true); err != nil || again.GetPts() != 0 {
		t.Fatalf("repeat = %v, %v", again, err)
	}

	// Reading the chat clears it even though the position does not move.
	readAck, err := h.svc.ReadHistory(ctx, a, chatID, top, 0)
	if err != nil {
		t.Fatal(err)
	}
	if readAck.GetPts() == 0 {
		t.Fatalf("read ack = %v", readAck)
	}
	if d, _ := h.dialogOf(a, chatID); d.GetUnreadMark() {
		t.Fatalf("mark survived the read: %v", d)
	}
	got := unreadMarks(h.logOf(a))
	if len(got) != 2 || got[1].GetUnread() {
		t.Fatalf("log after read = %v", got)
	}

	// Cleared by hand.
	if _, err := h.svc.SetDialogUnreadMark(ctx, a, chatID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.SetDialogUnreadMark(ctx, a, chatID, false); err != nil {
		t.Fatal(err)
	}
	if d, _ := h.dialogOf(a, chatID); d.GetUnreadMark() {
		t.Fatalf("mark after clearing = %v", d)
	}
	if _, err := h.svc.SetDialogUnreadMark(ctx, stranger, chatID, true); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("stranger marks: %v", err)
	}
}
