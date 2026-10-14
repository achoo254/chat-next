package chat

import (
	"context"
	"slices"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"connectrpc.com/connect"
)

func pinnedSeqs(resp *appv1.GetPinnedMessagesResponse) []int64 {
	var seqs []int64
	for _, m := range resp.GetMessages() {
		seqs = append(seqs, m.GetSeq())
	}
	return seqs
}

func (h *harness) pinned(me, chatID, topicID, offset int64, limit int32) *appv1.GetPinnedMessagesResponse {
	h.t.Helper()
	resp, err := h.svc.GetPinnedMessages(context.Background(), me, &appv1.GetPinnedMessagesRequest{
		ChatId: chatID, TopicId: topicID, OffsetSeq: offset, Limit: limit,
	})
	if err != nil {
		h.t.Fatal(err)
	}
	return resp
}

func (h *harness) pin(me, chatID, seq int64) {
	h.t.Helper()
	if _, err := h.svc.PinMessage(context.Background(), me, chatID, seq); err != nil {
		h.t.Fatal(err)
	}
}

func TestPinnedMessagesListAndCounts(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner, member, late, stranger := h.user("owner"), h.user("member"), h.user("late"), h.user("stranger")
	chatID := h.group(owner, member)
	s1 := h.send(member, chatID, "first").GetMessage().GetSeq()
	s2 := h.send(member, chatID, "second").GetMessage().GetSeq()
	s3 := h.send(owner, chatID, "third").GetMessage().GetSeq()
	for _, seq := range []int64{s2, s1, s3} {
		h.pin(owner, chatID, seq)
	}

	// Newest first, with the total count, paged by seq.
	all := h.pinned(member, chatID, 0, 0, 0)
	if !slices.Equal(pinnedSeqs(all), []int64{s3, s2, s1}) || all.GetCount() != 3 || all.GetHasMore() {
		t.Fatalf("pinned = %v count %d more %v", pinnedSeqs(all), all.GetCount(), all.GetHasMore())
	}
	if all.GetMessages()[0].GetText() != "third" || len(all.GetUsers()) == 0 {
		t.Fatalf("pinned messages are not rendered with their users: %v", all)
	}
	page := h.pinned(member, chatID, 0, 0, 2)
	if !slices.Equal(pinnedSeqs(page), []int64{s3, s2}) || !page.GetHasMore() || page.GetCount() != 3 {
		t.Fatalf("first page = %v more %v", pinnedSeqs(page), page.GetHasMore())
	}
	next := h.pinned(member, chatID, 0, s2, 2)
	if !slices.Equal(pinnedSeqs(next), []int64{s1}) || next.GetHasMore() {
		t.Fatalf("second page = %v more %v", pinnedSeqs(next), next.GetHasMore())
	}

	// The dialog carries the caller's count and newest pin; the chat keeps
	// pinned_seq as the newest pin.
	if d, _ := h.dialogOf(member, chatID); d.GetPinnedMessageCount() != 3 || d.GetPinnedMessageSeq() != s3 {
		t.Fatalf("dialog = %v", d)
	}
	if c, _, err := h.svc.GetChat(ctx, member, chatID); err != nil || c.GetPinnedSeq() != s3 {
		t.Fatalf("chat = %v, %v", c, err)
	}

	// A message hidden for me leaves my list and count, not others'.
	if _, err := h.svc.DeleteMessages(ctx, member, chatID, []int64{s1}, false); err != nil {
		t.Fatal(err)
	}
	if got := h.pinned(member, chatID, 0, 0, 0); got.GetCount() != 2 || !slices.Equal(pinnedSeqs(got), []int64{s3, s2}) {
		t.Fatalf("after hiding = %v", pinnedSeqs(got))
	}
	if d, _ := h.dialogOf(member, chatID); d.GetPinnedMessageCount() != 2 {
		t.Fatalf("dialog after hiding = %v", d)
	}
	if got := h.pinned(owner, chatID, 0, 0, 0); got.GetCount() != 3 {
		t.Fatalf("owner count after member hid = %d", got.GetCount())
	}

	// A member who joined with history hidden sees no earlier pin.
	if _, err := h.svc.SetHistoryVisibility(ctx, owner, chatID, appv1.HistoryVisibility_HISTORY_VISIBILITY_SINCE_JOIN); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.AddMembers(ctx, owner, chatID, []int64{late}); err != nil {
		t.Fatal(err)
	}
	if got := h.pinned(late, chatID, 0, 0, 0); got.GetCount() != 0 || len(got.GetMessages()) != 0 {
		t.Fatalf("late member sees %v", pinnedSeqs(got))
	}
	if d, _ := h.dialogOf(late, chatID); d.GetPinnedMessageCount() != 0 || d.GetPinnedMessageSeq() != 0 {
		t.Fatalf("late member dialog = %v", d)
	}

	// Unpinning one falls back to the next newest.
	if _, err := h.svc.UnpinMessage(ctx, owner, chatID, s3); err != nil {
		t.Fatal(err)
	}
	if c, _, _ := h.svc.GetChat(ctx, owner, chatID); c.GetPinnedSeq() != s2 {
		t.Fatalf("pinned_seq after unpin = %d", c.GetPinnedSeq())
	}

	// Authorization.
	if _, err := h.svc.GetPinnedMessages(ctx, stranger, &appv1.GetPinnedMessagesRequest{ChatId: chatID}); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("stranger lists pins: %v", err)
	}
	if _, err := h.svc.UnpinAllMessages(ctx, member, chatID, 0); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("member unpins all: %v", err)
	}
	if _, err := h.svc.GetPinnedMessages(ctx, member, &appv1.GetPinnedMessagesRequest{ChatId: chatID, TopicId: 2}); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("topic of a plain group: %v", err)
	}
	if _, err := h.svc.GetPinnedMessages(ctx, member, &appv1.GetPinnedMessagesRequest{ChatId: chatID, OffsetSeq: -1}); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("negative offset: %v", err)
	}
}

func TestUnpinAllMessagesSyncsAndScopesToTopic(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner, member := h.user("owner"), h.user("member")
	created, err := h.svc.CreateGroup(ctx, owner, "forum", []int64{member}, true)
	if err != nil {
		t.Fatal(err)
	}
	chatID := created.GetChat().GetId()
	topic, _, err := h.svc.CreateForumTopic(ctx, owner, &appv1.CreateForumTopicRequest{ChatId: chatID, Title: "Release"})
	if err != nil {
		t.Fatal(err)
	}
	post := func(topicID int64, text string) int64 {
		resp, err := h.svc.SendMessage(ctx, member, &appv1.SendMessageRequest{ChatId: chatID, Text: text, TopicId: topicID})
		if err != nil {
			t.Fatal(err)
		}
		return resp.GetMessage().GetSeq()
	}
	general1, general2 := post(generalTopicID, "general one"), post(generalTopicID, "general two")
	release1, release2 := post(topic.GetId(), "release one"), post(topic.GetId(), "release two")
	for _, seq := range []int64{general1, general2, release1, release2} {
		h.pin(owner, chatID, seq)
	}
	if got := h.pinned(member, chatID, topic.GetId(), 0, 0); !slices.Equal(pinnedSeqs(got), []int64{release2, release1}) || got.GetCount() != 2 {
		t.Fatalf("topic pins = %v (%d)", pinnedSeqs(got), got.GetCount())
	}
	if got := h.pinned(member, chatID, 0, 0, 0); got.GetCount() != 4 {
		t.Fatalf("chat pins = %d", got.GetCount())
	}

	h.drain()
	before := len(h.sink.updatesOf(member))
	ack, err := h.svc.UnpinAllMessages(ctx, owner, chatID, topic.GetId())
	if err != nil {
		t.Fatal(err)
	}
	if ack.GetPts() == 0 {
		t.Fatalf("ack = %v", ack)
	}
	if got := h.pinned(member, chatID, topic.GetId(), 0, 0); got.GetCount() != 0 {
		t.Fatalf("topic pins left = %v", pinnedSeqs(got))
	}
	if got := h.pinned(member, chatID, 0, 0, 0); !slices.Equal(pinnedSeqs(got), []int64{general2, general1}) {
		t.Fatalf("other topic's pins = %v", pinnedSeqs(got))
	}
	if c, _, _ := h.svc.GetChat(ctx, member, chatID); c.GetPinnedSeq() != general2 {
		t.Fatalf("pinned_seq = %d", c.GetPinnedSeq())
	}

	// One pin update lists every unpinned seq, in every member's log and in
	// realtime.
	wantPin := func(u *appv1.Update) bool {
		p := u.GetPin()
		return p != nil && !p.GetPinned() && p.GetSeq() == 0 && slices.Equal(p.GetSeqs(), []int64{release1, release2})
	}
	for _, user := range []int64{owner, member} {
		log := h.logOf(user)
		if !wantPin(log[len(log)-1]) {
			t.Fatalf("log tail of %d = %v", user, log[len(log)-1])
		}
	}
	h.drain()
	live := h.sink.updatesOf(member)[before:]
	if len(live) != 1 || !wantPin(live[0]) {
		t.Fatalf("realtime = %v", live)
	}

	// Nothing left to unpin writes nothing.
	again, err := h.svc.UnpinAllMessages(ctx, owner, chatID, topic.GetId())
	if err != nil || again.GetPts() != 0 {
		t.Fatalf("second unpin all = %v, %v", again, err)
	}
	if _, err := h.svc.UnpinAllMessages(ctx, owner, chatID, 0); err != nil {
		t.Fatal(err)
	}
	if c, _, _ := h.svc.GetChat(ctx, member, chatID); c.GetPinnedSeq() != 0 {
		t.Fatalf("pinned_seq after unpinning all = %d", c.GetPinnedSeq())
	}
	if d, _ := h.dialogOf(member, chatID); d.GetPinnedMessageCount() != 0 || d.GetPinnedMessageSeq() != 0 {
		t.Fatalf("dialog after unpinning all = %v", d)
	}
}
