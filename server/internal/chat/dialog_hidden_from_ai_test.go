package chat

import (
	"context"
	"maps"
	"slices"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"connectrpc.com/connect"
)

func TestDialogHiddenFromAI(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a, b, stranger := h.user("a"), h.user("b"), h.user("stranger")
	chatID := h.group(a, b)
	h.linkChat(a, chatID, "both")

	resp, err := h.svc.SetDialogHiddenFromAI(ctx, a, chatID, true)
	if err != nil {
		t.Fatal(err)
	}
	if !resp.GetHidden() || resp.GetAck().GetPts() == 0 {
		t.Fatalf("response = %v", resp)
	}
	if d, _ := h.dialogOf(a, chatID); !d.GetHiddenFromAi() {
		t.Fatalf("dialog = %v", d)
	}
	// Only the caller's dialog changes.
	if d, _ := h.dialogOf(b, chatID); d.GetHiddenFromAi() {
		t.Fatalf("other member's dialog hidden: %v", d)
	}
	// It is Chat's own setting: nothing goes to the linked app.
	if ops := h.queuedOps(chatID); len(ops) != 0 {
		t.Fatalf("queued for the linked app: %v", ops)
	}
	// The caller's sessions learn it in realtime and from the log; nobody else does.
	h.drain()
	var got []*appv1.UpdateDialogHiddenFromAI
	for _, u := range h.sink.updatesOf(a) {
		if x := u.GetDialogHiddenFromAi(); x != nil {
			got = append(got, x)
		}
	}
	if len(got) != 1 || got[0].GetChatId() != chatID || !got[0].GetHidden() {
		t.Fatalf("realtime dialog_hidden_from_ai = %v", got)
	}
	for _, u := range h.sink.updatesOf(b) {
		if u.GetDialogHiddenFromAi() != nil {
			t.Fatalf("other member got %v", u)
		}
	}
	if log := h.logOf(a); !log[len(log)-1].GetDialogHiddenFromAi().GetHidden() {
		t.Fatalf("log tail = %v", log[len(log)-1])
	}

	// Setting the same value again changes nothing.
	again, err := h.svc.SetDialogHiddenFromAI(ctx, a, chatID, true)
	if err != nil || !again.GetHidden() || again.GetAck().GetPts() != 0 {
		t.Fatalf("again = %v, %v", again, err)
	}
	off, err := h.svc.SetDialogHiddenFromAI(ctx, a, chatID, false)
	if err != nil || off.GetHidden() {
		t.Fatalf("show again = %v, %v", off, err)
	}
	if d, _ := h.dialogOf(a, chatID); d.GetHiddenFromAi() {
		t.Fatalf("dialog after showing = %v", d)
	}
	if _, err := h.svc.SetDialogHiddenFromAI(ctx, stranger, chatID, true); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("non-member hides: %v", err)
	}
}

func TestSentViaAIIsSeenByTheSenderOnlyAndTheLinkedAppGetsTheSameSend(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a, b := h.user("a"), h.user("b")
	chatID := h.group(a, b)
	h.linkChat(a, chatID, "both")

	viaAI, err := h.svc.SendMessage(ViaAI(ctx), a, &appv1.SendMessageRequest{ChatId: chatID, Text: "drafted by AI", RandomId: 1})
	if err != nil {
		t.Fatal(err)
	}
	typed := h.send(a, chatID, "typed")

	sentViaAIOf := func(viewer int64) map[int64]bool {
		t.Helper()
		resp, err := h.svc.GetHistory(ctx, viewer, &appv1.GetHistoryRequest{ChatId: chatID})
		if err != nil {
			t.Fatal(err)
		}
		out := map[int64]bool{}
		for _, m := range resp.GetMessages() {
			out[m.GetSeq()] = m.GetSentViaAi()
		}
		return out
	}
	mine := sentViaAIOf(a)
	if !mine[viaAI.GetMessage().GetSeq()] || mine[typed.GetMessage().GetSeq()] {
		t.Fatalf("sender's sent_via_ai = %v", mine)
	}
	if theirs := sentViaAIOf(b); slices.Contains(slices.Collect(maps.Values(theirs)), true) {
		t.Fatalf("other member's sent_via_ai = %v", theirs)
	}
	// The linked app gets it like any other send.
	if rows := h.outboxRows(chatID, viaAI.GetMessage().GetSeq()); !slices.Equal(rows, h.outboxRows(chatID, typed.GetMessage().GetSeq())) || len(rows) == 0 {
		t.Fatalf("outbox of the AI send = %v, of the typed send = %v", rows, h.outboxRows(chatID, typed.GetMessage().GetSeq()))
	}
}
