package chat

import (
	"context"
	"slices"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"connectrpc.com/connect"
)

func TestUnreadMentionsAreCounted(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a, b, c := h.user("alice"), h.user("bob"), h.user("carol")
	chatID := h.group(a, b, c)
	mine := h.send(b, chatID, "bob's question").GetMessage().GetSeq()
	// @bob by username, bob by id, a reply to bob, and one for carol only.
	if _, err := h.svc.SendMessage(ctx, a, &appv1.SendMessageRequest{ChatId: chatID, Text: "hi @bob",
		Entities: []*appv1.MessageEntity{{Type: appv1.EntityType_ENTITY_TYPE_MENTION, Offset: 3, Length: 4}}}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.SendMessage(ctx, a, &appv1.SendMessageRequest{ChatId: chatID, Text: "Bob!",
		Entities: []*appv1.MessageEntity{{Type: appv1.EntityType_ENTITY_TYPE_MENTION_NAME, Offset: 0, Length: 3, UserId: b}}}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.SendMessage(ctx, c, &appv1.SendMessageRequest{ChatId: chatID, Text: "answer", ReplyToSeq: mine}); err != nil {
		t.Fatal(err)
	}
	last := h.send(a, chatID, "@carol").GetMessage().GetSeq()
	dialog := func(user int64) *appv1.Dialog {
		t.Helper()
		d, err := h.svc.GetPeerDialogs(ctx, user, []int64{chatID})
		if err != nil || len(d.GetDialogs()) != 1 {
			t.Fatalf("dialogs = %v, %v", d, err)
		}
		return d.GetDialogs()[0]
	}
	if n := dialog(b).GetUnreadMentionsCount(); n != 3 {
		t.Fatalf("bob's unread mentions = %d, want 3", n)
	}
	// An edit that drops the mention drops it from the count.
	hist, err := h.svc.GetHistory(ctx, a, &appv1.GetHistoryRequest{ChatId: chatID})
	if err != nil {
		t.Fatal(err)
	}
	byID := hist.GetMessages()[len(hist.GetMessages())-3] // "Bob!"
	if _, err := h.svc.EditMessage(ctx, a, &appv1.EditMessageRequest{ChatId: chatID, Seq: byID.GetSeq(), Text: "nobody"}); err != nil {
		t.Fatal(err)
	}
	if n := dialog(b).GetUnreadMentionsCount(); n != 2 {
		t.Fatalf("after the edit bob's unread mentions = %d, want 2", n)
	}
	if _, err := h.svc.ReadHistory(ctx, b, chatID, last, 0); err != nil {
		t.Fatal(err)
	}
	if n := dialog(b).GetUnreadMentionsCount(); n != 0 {
		t.Fatalf("after reading, mentions = %d", n)
	}
}

func TestForumTopicIconCountsAndMentions(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a, b := h.user("alice"), h.user("bob")
	resp, err := h.svc.CreateGroup(ctx, a, "forum", []int64{b}, true)
	if err != nil {
		t.Fatal(err)
	}
	chatID := resp.GetChat().GetId()
	if _, _, err := h.svc.CreateForumTopic(ctx, a, &appv1.CreateForumTopicRequest{ChatId: chatID, Title: "x", Icon: "Bad Icon"}); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("invalid icon: %v", err)
	}
	topic, _, err := h.svc.CreateForumTopic(ctx, a, &appv1.CreateForumTopicRequest{ChatId: chatID, Title: "Deploys", Icon: "megaphone"})
	if err != nil || topic.GetIcon() != "megaphone" {
		t.Fatalf("topic = %v, %v", topic, err)
	}
	var seqs []int64
	for _, text := range []string{"one", "two @bob", "three"} {
		var ents []*appv1.MessageEntity
		if text == "two @bob" {
			ents = []*appv1.MessageEntity{{Type: appv1.EntityType_ENTITY_TYPE_MENTION, Offset: 4, Length: 4}}
		}
		m, err := h.svc.SendMessage(ctx, a, &appv1.SendMessageRequest{ChatId: chatID, Text: text, TopicId: topic.GetId(), Entities: ents})
		if err != nil {
			t.Fatal(err)
		}
		seqs = append(seqs, m.GetMessage().GetSeq())
	}
	if _, err := h.svc.DeleteMessages(ctx, a, chatID, seqs[:1], true); err != nil {
		t.Fatal(err)
	}
	icon := "rocket"
	if got, _, err := h.svc.EditForumTopic(ctx, a, &appv1.EditForumTopicRequest{ChatId: chatID, TopicId: topic.GetId(), Icon: &icon}); err != nil || got.GetIcon() != icon {
		t.Fatalf("edit icon = %v, %v", got, err)
	}
	list, err := h.svc.GetForumTopics(ctx, b, chatID, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	i := slices.IndexFunc(list.GetTopics(), func(tp *appv1.ForumTopic) bool { return tp.GetId() == topic.GetId() })
	got := list.GetTopics()[i]
	if got.GetMessageCount() != 2 || got.GetUnreadMentionsCount() != 1 || got.GetUnreadCount() != 2 || got.GetIcon() != icon {
		t.Fatalf("topic = %v, want 2 messages, 1 unread mention", got)
	}
	general := list.GetTopics()[slices.IndexFunc(list.GetTopics(), func(tp *appv1.ForumTopic) bool { return tp.GetId() == generalTopicID })]
	if general.GetMessageCount() != 1 { // "group created"
		t.Fatalf("General = %v", general)
	}
}

func TestReadersCarryReadDates(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a, b, c := h.user("a"), h.user("b"), h.user("c")
	chatID := h.group(a, b, c)
	seq := h.send(a, chatID, "read me").GetMessage().GetSeq()
	before := time.Now().Add(-time.Second).Unix()
	if _, err := h.svc.ReadHistory(ctx, b, chatID, seq, 0); err != nil {
		t.Fatal(err)
	}
	// A later read moves c's position further; the date of this message is
	// still when c first got past it.
	if _, err := h.svc.ReadHistory(ctx, c, chatID, seq, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := h.st.Pool().Exec(ctx, `UPDATE read_receipts SET read_at = read_at - interval '1 hour' WHERE user_id = $1`, c); err != nil {
		t.Fatal(err)
	}
	h.send(b, chatID, "later")
	if _, err := h.svc.ReadHistory(ctx, c, chatID, seq+1, 0); err != nil {
		t.Fatal(err)
	}
	r, err := h.svc.GetMessageReaders(ctx, a, chatID, seq)
	if err != nil || len(r.GetReaders()) != 2 {
		t.Fatalf("readers = %v, %v", r, err)
	}
	if r.GetReaders()[0].GetUserId() != b || r.GetReaders()[0].GetReadAt() < before {
		t.Fatalf("most recent reader = %v", r.GetReaders()[0])
	}
	if cr := r.GetReaders()[1]; cr.GetUserId() != c || cr.GetReadAt() > time.Now().Add(-50*time.Minute).Unix() {
		t.Fatalf("c's read date = %v, want the first read", cr)
	}
	if !slices.Equal(r.GetUserIds(), []int64{b, c}) {
		t.Fatalf("user_ids = %v", r.GetUserIds())
	}
}

func TestCheckInvitePreviewAndReportReasons(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner, admin, m1, m2, m3, m4, guest := h.user("owner"), h.user("admin"), h.user("m1"), h.user("m2"), h.user("m3"), h.user("m4"), h.user("guest")
	chatID := h.group(owner, m1, m2, m3, m4, admin)
	if _, err := h.svc.SetAdmin(ctx, owner, chatID, admin, true); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.SetHistoryVisibility(ctx, owner, chatID, appv1.HistoryVisibility_HISTORY_VISIBILITY_SINCE_JOIN); err != nil {
		t.Fatal(err)
	}
	preview, err := h.svc.CheckInvite(ctx, guest, inviteOf(t, h, owner, chatID))
	if err != nil {
		t.Fatal(err)
	}
	if len(preview.GetMemberIds()) != invitePreviewMembers || preview.GetMemberIds()[0] != owner || preview.GetMemberIds()[1] != admin ||
		len(preview.GetUsers()) != invitePreviewMembers || preview.GetHistoryVisibility() != appv1.HistoryVisibility_HISTORY_VISIBILITY_SINCE_JOIN {
		t.Fatalf("preview = %v (admins first)", preview)
	}
	for _, reason := range []appv1.ReportReason{appv1.ReportReason_REPORT_REASON_SCAM, appv1.ReportReason_REPORT_REASON_SEXUAL} {
		if err := h.svc.Report(ctx, guest, &appv1.ReportRequest{Target: &appv1.ReportRequest_UserId{UserId: m1}, Reason: reason}); err != nil {
			t.Fatalf("report %v: %v", reason, err)
		}
	}
}
