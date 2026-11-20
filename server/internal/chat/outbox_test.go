package chat

import (
	"context"
	"fmt"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"connectrpc.com/connect"
)

// linkChat links chatID to a new external account of owner with direction.
func (h *harness) linkChat(owner, chatID int64, direction string) int64 {
	h.t.Helper()
	ctx := context.Background()
	var accountID int64
	if err := h.st.Pool().QueryRow(ctx, `
		INSERT INTO external_accounts (owner_id, source, external_ref, secret) VALUES ($1, 'telegram', $2, '\x00') RETURNING id`,
		owner, fmt.Sprintf("tg-%d-%d", owner, chatID)).Scan(&accountID); err != nil {
		h.t.Fatal(err)
	}
	if _, err := h.st.Pool().Exec(ctx, `INSERT INTO external_chats (account_id, external_chat_id, chat_id, direction) VALUES ($1, 'c1', $2, $3)`,
		accountID, chatID, direction); err != nil {
		h.t.Fatal(err)
	}
	return accountID
}

// outboxRows returns "op:status" of every queue row of the message.
func (h *harness) outboxRows(chatID, seq int64) []string {
	h.t.Helper()
	rows, err := h.st.Pool().Query(context.Background(), `SELECT op || ':' || status FROM external_outbox WHERE chat_id = $1 AND seq = $2 ORDER BY id`, chatID, seq)
	if err != nil {
		h.t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			h.t.Fatal(err)
		}
		out = append(out, s)
	}
	return out
}

func (h *harness) markSent(accountID, chatID, seq int64, externalID string) {
	h.t.Helper()
	ctx := context.Background()
	if _, err := h.st.Pool().Exec(ctx, `UPDATE external_outbox SET status = 'sent' WHERE chat_id = $1 AND seq = $2 AND op = 'send'`, chatID, seq); err != nil {
		h.t.Fatal(err)
	}
	if _, err := h.st.Pool().Exec(ctx, `INSERT INTO external_messages (account_id, external_chat_id, external_msg_id, chat_id, seq) VALUES ($1, 'c1', $2, $3, $4)`,
		accountID, externalID, chatID, seq); err != nil {
		h.t.Fatal(err)
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestSendIntoTwoWayChatQueuesOneRowWithoutContent(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	chatID := h.group(owner)
	h.linkChat(owner, chatID, DirectionBoth)
	resp, err := h.svc.SendMessage(ctx, owner, &appv1.SendMessageRequest{ChatId: chatID, Text: "xin chào"})
	if err != nil {
		t.Fatalf("send into a two-way chat: %v", err)
	}
	seq := resp.GetMessage().GetSeq()
	if got := h.outboxRows(chatID, seq); !equalStrings(got, []string{"send:pending"}) {
		t.Fatalf("queue = %v, want one pending send", got)
	}
	var randomID int64
	if err := h.st.Pool().QueryRow(ctx, `SELECT random_id FROM external_outbox WHERE chat_id = $1 AND seq = $2`, chatID, seq).Scan(&randomID); err != nil || randomID <= 0 {
		t.Fatalf("random_id = %d err %v, want a positive id kept for retries", randomID, err)
	}
	// A client retry with the same random_id returns the first message and queues nothing more.
	req := &appv1.SendMessageRequest{ChatId: chatID, Text: "lần hai", RandomId: 777}
	first, err := h.svc.SendMessage(ctx, owner, req)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.SendMessage(ctx, owner, req); err != nil {
		t.Fatal(err)
	}
	if got := h.outboxRows(chatID, first.GetMessage().GetSeq()); len(got) != 1 {
		t.Fatalf("a retried send queued %v, want exactly one row", got)
	}
}

func TestOneWayChatStillRefusesAndNothingIsQueued(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	chatID := h.group(owner)
	h.linkChat(owner, chatID, DirectionIn)
	_, err := h.svc.SendMessage(ctx, owner, &appv1.SendMessageRequest{ChatId: chatID, Text: "hello"})
	if codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("send into a one-way chat = %v, want PermissionDenied", err)
	}
	var n int
	if err := h.st.Pool().QueryRow(ctx, `SELECT count(*) FROM external_outbox`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("queue has %d rows (err %v), want none", n, err)
	}
}

func TestTwoWayChatRefusesWhatCannotBeSentOn(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	other := h.user("other")
	chatID := h.group(owner, other)
	h.linkChat(owner, chatID, DirectionBoth)
	if _, err := h.svc.SendMessage(ctx, other, &appv1.SendMessageRequest{ChatId: chatID, Text: "from someone else"}); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("another member sending = %v, want PermissionDenied", err)
	}
	var n int
	if err := h.st.Pool().QueryRow(ctx, `SELECT count(*) FROM external_outbox`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("queue has %d rows (err %v), want none", n, err)
	}
}

func TestTheOwnersForwardIntoATwoWayChatIsQueuedWithItsOriginal(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	chatID := h.group(owner)
	h.linkChat(owner, chatID, DirectionBoth)
	src := h.group(owner)
	msg := h.send(owner, src, "to forward")
	if _, err := h.svc.ForwardMessages(ctx, owner, &appv1.ForwardMessagesRequest{FromChatId: src, Seqs: []int64{msg.GetMessage().GetSeq()}, ToChatId: chatID, RandomIds: []int64{5}}); err != nil {
		t.Fatalf("forwarding into a two-way chat: %v", err)
	}
	var fromChat, fromSeq int64
	if err := h.st.Pool().QueryRow(ctx, `SELECT (payload->>'from_chat')::bigint, (payload->>'from_seq')::bigint FROM external_outbox WHERE op = 'send'`).Scan(&fromChat, &fromSeq); err != nil {
		t.Fatal(err)
	}
	if fromChat != src || fromSeq != msg.GetMessage().GetSeq() {
		t.Fatalf("queued forward names %d/%d, want %d/%d", fromChat, fromSeq, src, msg.GetMessage().GetSeq())
	}
}

func TestDisconnectedAccountRefusesSending(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	chatID := h.group(owner)
	account := h.linkChat(owner, chatID, DirectionBoth)
	if _, err := h.st.Pool().Exec(ctx, `UPDATE external_accounts SET status = 'stopped' WHERE id = $1`, account); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.SendMessage(ctx, owner, &appv1.SendMessageRequest{ChatId: chatID, Text: "hello"}); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("send through a stopped account = %v, want PermissionDenied", err)
	}
}

func TestEditQueuesOnlyAfterTheSendWentOut(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	chatID := h.group(owner)
	account := h.linkChat(owner, chatID, DirectionBoth)
	resp, err := h.svc.SendMessage(ctx, owner, &appv1.SendMessageRequest{ChatId: chatID, Text: "one"})
	if err != nil {
		t.Fatal(err)
	}
	seq := resp.GetMessage().GetSeq()
	if _, err := h.svc.EditMessage(ctx, owner, &appv1.EditMessageRequest{ChatId: chatID, Seq: seq, Text: "two"}); err != nil {
		t.Fatal(err)
	}
	if got := h.outboxRows(chatID, seq); !equalStrings(got, []string{"send:pending"}) {
		t.Fatalf("edit before the send = %v, want only the pending send (it goes out with the new text)", got)
	}
	h.markSent(account, chatID, seq, "900001")
	if _, err := h.svc.EditMessage(ctx, owner, &appv1.EditMessageRequest{ChatId: chatID, Seq: seq, Text: "three"}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.st.Pool().Exec(ctx, `UPDATE external_outbox SET status = 'sent', attempts = 3 WHERE chat_id = $1 AND seq = $2 AND op = 'edit'`, chatID, seq); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.EditMessage(ctx, owner, &appv1.EditMessageRequest{ChatId: chatID, Seq: seq, Text: "four"}); err != nil {
		t.Fatal(err)
	}
	if got := h.outboxRows(chatID, seq); !equalStrings(got, []string{"send:sent", "edit:pending"}) {
		t.Fatalf("queue after two edits = %v, want one edit row, pending again", got)
	}
	var attempts int
	if err := h.st.Pool().QueryRow(ctx, `SELECT attempts FROM external_outbox WHERE chat_id = $1 AND seq = $2 AND op = 'edit'`, chatID, seq).Scan(&attempts); err != nil || attempts != 0 {
		t.Fatalf("attempts = %d (err %v), want a new edit to start from zero", attempts, err)
	}
}

func TestDeleteForEveryoneCancelsOrQueues(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	chatID := h.group(owner)
	account := h.linkChat(owner, chatID, DirectionBoth)
	waiting, err := h.svc.SendMessage(ctx, owner, &appv1.SendMessageRequest{ChatId: chatID, Text: "never goes out"})
	if err != nil {
		t.Fatal(err)
	}
	gone, err := h.svc.SendMessage(ctx, owner, &appv1.SendMessageRequest{ChatId: chatID, Text: "went out"})
	if err != nil {
		t.Fatal(err)
	}
	ws, gs := waiting.GetMessage().GetSeq(), gone.GetMessage().GetSeq()
	h.markSent(account, chatID, gs, "900002")
	if _, err := h.svc.DeleteMessages(ctx, owner, chatID, []int64{ws, gs}, true); err != nil {
		t.Fatal(err)
	}
	if got := h.outboxRows(chatID, ws); !equalStrings(got, []string{"send:cancelled"}) {
		t.Fatalf("delete of a message not sent yet = %v, want its send cancelled and no delete row", got)
	}
	if got := h.outboxRows(chatID, gs); !equalStrings(got, []string{"send:sent", "delete:pending"}) {
		t.Fatalf("delete of a message already sent = %v, want a delete row", got)
	}
}

func TestDeleteJustForMeQueuesNothing(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	chatID := h.group(owner)
	account := h.linkChat(owner, chatID, DirectionBoth)
	resp, err := h.svc.SendMessage(ctx, owner, &appv1.SendMessageRequest{ChatId: chatID, Text: "keep over there"})
	if err != nil {
		t.Fatal(err)
	}
	seq := resp.GetMessage().GetSeq()
	h.markSent(account, chatID, seq, "900003")
	if _, err := h.svc.DeleteMessages(ctx, owner, chatID, []int64{seq}, false); err != nil {
		t.Fatal(err)
	}
	if got := h.outboxRows(chatID, seq); !equalStrings(got, []string{"send:sent"}) {
		t.Fatalf("hiding a message = %v, want no new row", got)
	}
}

func TestSetImportedDirection(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	stranger := h.user("stranger")
	chatID := h.group(owner)
	h.linkChat(owner, chatID, DirectionIn)
	if err := h.svc.SetImportedDirection(ctx, stranger, chatID, DirectionBoth); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("a stranger switching the direction = %v, want NotFound", err)
	}
	if err := h.svc.SetImportedDirection(ctx, owner, chatID, "sideways"); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("a bad direction = %v, want InvalidArgument", err)
	}
	before := len(h.logOf(owner))
	if err := h.svc.SetImportedDirection(ctx, owner, chatID, DirectionBoth); err != nil {
		t.Fatal(err)
	}
	updated := false
	for _, u := range h.logOf(owner)[before:] {
		if cu, ok := u.GetKind().(*appv1.Update_ChatUpdated); ok && cu.ChatUpdated.GetChat().GetId() == chatID {
			updated = true
		}
	}
	if !updated {
		t.Fatal("the owner's sessions were not told the chat changed when its direction did")
	}
	resp, err := h.svc.SendMessage(ctx, owner, &appv1.SendMessageRequest{ChatId: chatID, Text: "now it goes"})
	if err != nil {
		t.Fatalf("send after switching to both: %v", err)
	}
	seq := resp.GetMessage().GetSeq()
	if err := h.svc.SetImportedDirection(ctx, owner, chatID, DirectionIn); err != nil {
		t.Fatal(err)
	}
	if got := h.outboxRows(chatID, seq); !equalStrings(got, []string{"send:cancelled"}) {
		t.Fatalf("queue after going back to one-way = %v, want the waiting send cancelled", got)
	}
	if _, err := h.svc.SendMessage(ctx, owner, &appv1.SendMessageRequest{ChatId: chatID, Text: "again"}); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("send after going back to one-way = %v, want PermissionDenied", err)
	}
}

func TestRemovingTheLinkDropsTheQueue(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	chatID := h.group(owner)
	h.linkChat(owner, chatID, DirectionBoth)
	if _, err := h.svc.SendMessage(ctx, owner, &appv1.SendMessageRequest{ChatId: chatID, Text: "queued"}); err != nil {
		t.Fatal(err)
	}
	if err := h.svc.DeleteImportedChat(ctx, owner, chatID); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := h.st.Pool().QueryRow(ctx, `SELECT count(*) FROM external_outbox`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("queue has %d rows (err %v) after the chat was removed, want none", n, err)
	}
}
