package chat

import (
	"context"
	"slices"
	"strings"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
)

func TestPermissionsAndRoles(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner, admin, member, other := h.user("owner"), h.user("admin"), h.user("member"), h.user("other")
	chatID := h.group(owner, admin, member, other)
	if _, err := h.svc.SetAdmin(ctx, admin, chatID, member, true); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("non-owner appoints: %v", err)
	}
	if _, err := h.svc.SetAdmin(ctx, owner, chatID, admin, true); err != nil {
		t.Fatal(err)
	}
	seq := h.send(member, chatID, "pin me").GetMessage().GetSeq()
	if _, err := h.svc.PinMessage(ctx, member, chatID, seq); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("member pins without the permission: %v", err)
	}
	if _, err := h.svc.PinMessage(ctx, admin, chatID, seq); err != nil {
		t.Fatal(err)
	}
	if c, _, _ := h.svc.GetChat(ctx, member, chatID); c.GetPinnedSeq() != seq {
		t.Fatalf("pinned_seq = %d, want %d", c.GetPinnedSeq(), seq)
	}
	// Restricting a member removes sending.
	if _, err := h.svc.SetMemberPermissions(ctx, admin, chatID, other, permAddMembers); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.SendMessage(ctx, other, &appv1.SendMessageRequest{ChatId: chatID, Text: "x"}); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("restricted member sends: %v", err)
	}
	// Admins remove members, not the owner; members remove nobody.
	if _, err := h.svc.RemoveMember(ctx, member, chatID, other, true); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("member removes: %v", err)
	}
	if _, err := h.svc.RemoveMember(ctx, admin, chatID, owner, true); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("admin removes the owner: %v", err)
	}
	if _, err := h.svc.RemoveMember(ctx, admin, chatID, other, true); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.SendMessage(ctx, other, &appv1.SendMessageRequest{ChatId: chatID, Text: "x"}); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("removed member sends: %v", err)
	}
	h.drain()
	if !slices.Contains(h.sink.forget, [2]int64{other, chatID}) {
		t.Fatalf("gateway not told to forget the chat: %v", h.sink.forget)
	}
	// The owner leaving hands the chat to the admin.
	if _, err := h.svc.LeaveChat(ctx, owner, chatID); err != nil {
		t.Fatal(err)
	}
	if c, _, _ := h.svc.GetChat(ctx, admin, chatID); c.GetMyRole() != appv1.MemberRole_MEMBER_ROLE_OWNER {
		t.Fatalf("heir role = %v", c.GetMyRole())
	}
	// Channels: only admins post.
	ch, err := h.svc.CreateChannel(ctx, owner, "news", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.svc.AddMembers(ctx, owner, ch.GetChat().GetId(), []int64{member}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.SendMessage(ctx, member, &appv1.SendMessageRequest{ChatId: ch.GetChat().GetId(), Text: "x"}); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("channel member posts: %v", err)
	}
	// Editing: only the author.
	if _, err := h.svc.EditMessage(ctx, admin, &appv1.EditMessageRequest{ChatId: chatID, Seq: seq, Text: "x"}); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("edit by another user: %v", err)
	}
	// Deleting: authors, and admins any message.
	if _, err := h.svc.DeleteMessages(ctx, admin, chatID, []int64{seq}, true); err != nil {
		t.Fatal(err)
	}
	if c, _, _ := h.svc.GetChat(ctx, member, chatID); c.GetPinnedSeq() != 0 {
		t.Fatalf("deleted message still pinned: %d", c.GetPinnedSeq())
	}
}

func TestPrivacyAndBlocks(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a, b := h.user("a"), h.user("b")
	if err := h.svc.Block(ctx, b, a); err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.svc.CreatePrivate(ctx, a, b); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("private chat with a user who blocked me: %v", err)
	}
	if err := h.svc.Unblock(ctx, b, a); err != nil {
		t.Fatal(err)
	}
	chat, _, err := h.svc.CreatePrivate(ctx, a, b)
	if err != nil {
		t.Fatal(err)
	}
	again, _, err := h.svc.CreatePrivate(ctx, b, a)
	if err != nil || again.GetId() != chat.GetId() || again.GetPeerUserId() != a {
		t.Fatalf("second CreatePrivate = %v, %v", again, err)
	}
	if err := h.svc.Block(ctx, b, a); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.SendMessage(ctx, a, &appv1.SendMessageRequest{ChatId: chat.GetId(), Text: "hi"}); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("message to a user who blocked me: %v", err)
	}
	if users, _ := h.svc.GetUsers(ctx, b, []int64{a}); len(users) != 1 || !users[0].GetIsBlocked() {
		t.Fatalf("blocked flag = %v", users)
	}
	// Default privacy: strangers cannot add c to groups; nobody can message d.
	c := h.user("c")
	if _, err := h.st.Pool().Exec(ctx, `DELETE FROM privacy_settings WHERE user_id = $1`, c); err != nil {
		t.Fatal(err)
	}
	resp, err := h.svc.CreateGroup(ctx, a, "g", []int64{c}, false)
	if err != nil || !slices.Equal(resp.GetFailedUserIds(), []int64{c}) {
		t.Fatalf("stranger added under default privacy: %v %v", resp, err)
	}
	d := h.user("d")
	nobody := appv1.PrivacyAudience_PRIVACY_AUDIENCE_NOBODY
	if _, err := h.svc.SetPrivacy(ctx, d, &appv1.SetPrivacyRequest{SendMessages: &nobody, LastSeen: &nobody}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.svc.CreatePrivate(ctx, a, d); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("message to a user who allows nobody: %v", err)
	}
	if p, _ := h.svc.GetPrivacy(ctx, d); p.GetSendMessages() != nobody || p.GetFindByEmail() != nobody || !p.GetNotificationPreview() {
		t.Fatalf("privacy = %v", p)
	}
	if _, err := h.svc.SetPrivacy(ctx, d, &appv1.SetPrivacyRequest{LastSeen: new(appv1.PrivacyAudience)}); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("unspecified audience accepted: %v", err)
	}
}

func TestInviteLinks(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner, member, joiner, late := h.user("owner"), h.user("member"), h.user("joiner"), h.user("late")
	chatID := h.group(owner, member)
	h.send(owner, chatID, "before")
	inv, err := h.svc.ExportInviteLink(ctx, owner, chatID, 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(inv.GetLink(), "https://chat.example.test/join/") || len(strings.TrimPrefix(inv.GetLink(), "https://chat.example.test/join/")) < 22 {
		t.Fatalf("link = %q", inv.GetLink())
	}
	preview, err := h.svc.CheckInvite(ctx, joiner, inv.GetLink())
	if err != nil || preview.GetTitle() != "group" || preview.GetMemberCount() != 2 || preview.GetChat() != nil {
		t.Fatalf("CheckInvite = %v, %v", preview, err)
	}
	joined, err := h.svc.JoinByInvite(ctx, joiner, inv.GetLink())
	if err != nil || joined.GetChat().GetMemberCount() != 3 {
		t.Fatalf("JoinByInvite = %v, %v", joined, err)
	}
	// The newcomer's log: member_added, a read position at the join point
	// (older history is not unread), then the service message.
	var kinds []string
	for _, u := range h.logOf(joiner) {
		kinds = append(kinds, kindOf(u))
		if r := u.GetRead(); r != nil && r.GetMaxSeq() != 2 {
			t.Fatalf("newcomer read position = %v", r)
		}
	}
	if !slices.Equal(kinds, []string{"MemberAdded", "Read", "MessageNew"}) {
		t.Fatalf("newcomer log = %v", kinds)
	}
	d, err := h.svc.GetPeerDialogs(ctx, joiner, []int64{chatID})
	if err != nil || d.GetDialogs()[0].GetUnreadCount() != 0 || d.GetDialogs()[0].GetReadInboxMaxSeq() != 2 {
		t.Fatalf("newcomer dialog = %v, %v", d, err)
	}
	// Usage limit 1 is used up; members may still "join" (returns the chat).
	if _, err := h.svc.JoinByInvite(ctx, late, inv.GetLink()); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("exhausted link: %v", err)
	}
	if _, err := h.svc.JoinByInvite(ctx, joiner, inv.GetLink()); err != nil {
		t.Fatalf("member re-using a link: %v", err)
	}
	inv2, err := h.svc.ExportInviteLink(ctx, owner, chatID, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.RevokeInviteLink(ctx, member, chatID, inv2.GetLink()); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("member revokes someone else's link: %v", err)
	}
	if r, err := h.svc.RevokeInviteLink(ctx, owner, chatID, inv2.GetLink()); err != nil || !r.GetRevoked() {
		t.Fatalf("revoke = %v, %v", r, err)
	}
	if _, err := h.svc.CheckInvite(ctx, late, inv2.GetLink()); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("revoked link: %v", err)
	}
	links, err := h.svc.GetInviteLinks(ctx, owner, chatID)
	if err != nil || len(links) != 2 {
		t.Fatalf("links = %v, %v", links, err)
	}
	if _, err := h.svc.CheckInvite(ctx, late, "garbage"); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("garbage link: %v", err)
	}
}

func TestHistoryVisibilityHideAndPaging(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a, b, c := h.user("a"), h.user("b"), h.user("c")
	chatID := h.group(a, b)
	for range 10 {
		h.send(a, chatID, "old")
	}
	if _, err := h.svc.SetHistoryVisibility(ctx, a, chatID, appv1.HistoryVisibility_HISTORY_VISIBILITY_SINCE_JOIN); err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.svc.AddMembers(ctx, a, chatID, []int64{c}); err != nil {
		t.Fatal(err)
	}
	h.send(a, chatID, "new")
	hist, err := h.svc.GetHistory(ctx, c, &appv1.GetHistoryRequest{ChatId: chatID})
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range hist.GetMessages() {
		if m.GetText() == "old" {
			t.Fatalf("newcomer sees history from before joining: %v", m)
		}
	}
	if hist.GetHasOlder() || len(hist.GetMessages()) != 2 {
		t.Fatalf("newcomer history = %v", hist)
	}
	// Paging: older pages of 4 from the newest.
	page, err := h.svc.GetHistory(ctx, b, &appv1.GetHistoryRequest{ChatId: chatID, Limit: 4})
	if err != nil || len(page.GetMessages()) != 4 || !page.GetHasOlder() || page.GetHasNewer() {
		t.Fatalf("first page = %v, %v", page, err)
	}
	first := page.GetMessages()[0].GetSeq()
	older, err := h.svc.GetHistory(ctx, b, &appv1.GetHistoryRequest{ChatId: chatID, OffsetSeq: first, Limit: 4,
		Direction: appv1.HistoryDirection_HISTORY_DIRECTION_OLDER})
	if err != nil || older.GetMessages()[3].GetSeq() != first-1 || !older.GetHasNewer() {
		t.Fatalf("older page = %v, %v", older, err)
	}
	around, err := h.svc.GetHistory(ctx, b, &appv1.GetHistoryRequest{ChatId: chatID, OffsetSeq: 5, Limit: 4,
		Direction: appv1.HistoryDirection_HISTORY_DIRECTION_AROUND})
	if err != nil || len(around.GetMessages()) != 4 || around.GetMessages()[1].GetSeq() != 5 {
		t.Fatalf("around page = %v, %v", around, err)
	}
	// Hidden for b only.
	if _, err := h.svc.DeleteMessages(ctx, b, chatID, []int64{5}, false); err != nil {
		t.Fatal(err)
	}
	newer, err := h.svc.GetHistory(ctx, b, &appv1.GetHistoryRequest{ChatId: chatID, OffsetSeq: 4, Limit: 2,
		Direction: appv1.HistoryDirection_HISTORY_DIRECTION_NEWER})
	if err != nil || newer.GetMessages()[0].GetSeq() != 6 {
		t.Fatalf("hidden message still listed for b: %v, %v", newer, err)
	}
	if forA, _ := h.svc.GetHistory(ctx, a, &appv1.GetHistoryRequest{ChatId: chatID, OffsetSeq: 4, Limit: 1,
		Direction: appv1.HistoryDirection_HISTORY_DIRECTION_NEWER}); forA.GetMessages()[0].GetSeq() != 5 {
		t.Fatalf("hidden for b, gone for a too: %v", forA)
	}
	hidden := h.logOf(b)
	if last := hidden[len(hidden)-1].GetMessageHidden(); last == nil || !slices.Equal(last.GetSeqs(), []int64{5}) {
		t.Fatalf("message_hidden missing from b's log: %v", hidden[len(hidden)-1])
	}
}

func TestUnreadCountsReadsAndReceipts(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a, b, c := h.user("a"), h.user("b"), h.user("c")
	chatID := h.group(a, b, c)
	var last int64
	for range 3 {
		last = h.send(a, chatID, "hi").GetMessage().GetSeq()
	}
	dl, err := h.svc.GetDialogs(ctx, b, "", 10)
	if err != nil || len(dl.GetDialogs()) != 1 || dl.GetDialogs()[0].GetUnreadCount() != 4 || dl.GetDialogs()[0].GetTopSeq() != last {
		t.Fatalf("dialogs = %v, %v", dl, err)
	}
	ack, err := h.svc.ReadHistory(ctx, b, chatID, last-1, 0)
	if err != nil || ack.GetPts() == 0 || ack.GetPtsCount() != 1 {
		t.Fatalf("read ack = %v, %v", ack, err)
	}
	log := h.logOf(b)
	r := log[len(log)-1].GetRead()
	if r.GetUnreadCount() != 1 || r.GetMaxSeq() != last-1 || r.GetTopSeq() != last || r.GetOutbox() {
		t.Fatalf("read update = %v", r)
	}
	// The author hears the outbox read once.
	aLog := h.logOf(a)
	if o := aLog[len(aLog)-1].GetRead(); o == nil || !o.GetOutbox() || o.GetMaxSeq() != last-1 {
		t.Fatalf("author's outbox read = %v", aLog[len(aLog)-1])
	}
	if ack, err := h.svc.ReadHistory(ctx, b, chatID, last-2, 0); err != nil || ack.GetPts() != 0 {
		t.Fatalf("reading backwards wrote an update: %v, %v", ack, err)
	}
	readers, err := h.svc.GetMessageReaders(ctx, a, chatID, last-1)
	if err != nil || !slices.Equal(readers.GetUserIds(), []int64{b}) {
		t.Fatalf("readers = %v, %v", readers, err)
	}
	if r, err := h.svc.GetMessageReaders(ctx, a, chatID, last); err != nil || len(r.GetUserIds()) != 0 {
		t.Fatalf("readers of an unread message = %v, %v", r, err)
	}
	h.svc.cfg.ReadReceiptsMemberMax = 2
	if _, err := h.svc.GetMessageReaders(ctx, a, chatID, last-1); codeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("readers in a group over the limit: %v", err)
	}
}

func TestForumTopics(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	admin, member := h.user("admin"), h.user("member")
	chatID := h.group(admin, member)
	h.send(member, chatID, "before topics")
	on := true
	if _, err := h.svc.UpdateChatInfo(ctx, member, &appv1.UpdateChatInfoRequest{ChatId: chatID, Forum: &on}); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("member turns topics on: %v", err)
	}
	info, err := h.svc.UpdateChatInfo(ctx, admin, &appv1.UpdateChatInfoRequest{ChatId: chatID, Forum: &on})
	if err != nil || !info.GetChat().GetForum() {
		t.Fatalf("forum on = %v, %v", info, err)
	}
	off := false
	if _, err := h.svc.UpdateChatInfo(ctx, admin, &appv1.UpdateChatInfoRequest{ChatId: chatID, Forum: &off}); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("forum off: %v", err)
	}
	topic, _, err := h.svc.CreateForumTopic(ctx, member, &appv1.CreateForumTopicRequest{ChatId: chatID, Title: "Alerts", IconColor: 0xff0000})
	if err != nil {
		t.Fatal(err)
	}
	msg := h.send(member, chatID, "general by default").GetMessage()
	if msg.GetTopicId() != generalTopicID {
		t.Fatalf("topic of a message without one = %d", msg.GetTopicId())
	}
	in, err := h.svc.SendMessage(ctx, admin, &appv1.SendMessageRequest{ChatId: chatID, Text: "alert", TopicId: topic.GetId()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.SendMessage(ctx, admin, &appv1.SendMessageRequest{ChatId: chatID, Text: "x", TopicId: 99}); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("unknown topic: %v", err)
	}
	if _, _, err := h.svc.CloseForumTopic(ctx, admin, chatID, topic.GetId(), true); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.SendMessage(ctx, member, &appv1.SendMessageRequest{ChatId: chatID, Text: "x", TopicId: topic.GetId()}); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("member posts in a closed topic: %v", err)
	}
	if _, err := h.svc.SendMessage(ctx, admin, &appv1.SendMessageRequest{ChatId: chatID, Text: "admin may", TopicId: topic.GetId()}); err != nil {
		t.Fatalf("admin posts in a closed topic: %v", err)
	}
	if _, _, err := h.svc.HideForumTopic(ctx, member, chatID, topic.GetId(), true); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("member hides a topic: %v", err)
	}
	if _, _, err := h.svc.HideForumTopic(ctx, admin, chatID, topic.GetId(), true); err != nil {
		t.Fatal(err)
	}
	title := "Alerts (ops)"
	if got, _, err := h.svc.EditForumTopic(ctx, member, &appv1.EditForumTopicRequest{ChatId: chatID, TopicId: topic.GetId(), Title: &title}); err != nil || got.GetTitle() != title {
		t.Fatalf("creator renames = %v, %v", got, err)
	}
	pinned := true
	if _, _, err := h.svc.EditForumTopic(ctx, member, &appv1.EditForumTopicRequest{ChatId: chatID, TopicId: topic.GetId(), Pinned: &pinned}); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("member pins a topic: %v", err)
	}
	list, err := h.svc.GetForumTopics(ctx, member, chatID, "", 0)
	if err != nil || len(list.GetTopics()) != 2 {
		t.Fatalf("topics = %v, %v", list, err)
	}
	byID := map[int64]*appv1.ForumTopic{}
	for _, tp := range list.GetTopics() {
		byID[tp.GetId()] = tp
	}
	alerts := byID[topic.GetId()]
	if !alerts.GetHidden() || !alerts.GetClosed() || alerts.GetUnreadCount() != 2 || alerts.GetTopSeq() <= in.GetMessage().GetSeq() {
		t.Fatalf("hidden topic = %v (hidden topics stay listed for members)", alerts)
	}
	// Reading one topic leaves the other unread.
	if _, err := h.svc.ReadHistory(ctx, member, chatID, alerts.GetTopSeq(), topic.GetId()); err != nil {
		t.Fatal(err)
	}
	log := h.logOf(member)
	r := log[len(log)-1].GetRead()
	if r.GetTopicId() != topic.GetId() || r.GetTopicUnreadCount() != 0 {
		t.Fatalf("topic read = %v", r)
	}
	// Pre-forum messages moved to General; reading General clears the rest.
	hist, err := h.svc.GetHistory(ctx, admin, &appv1.GetHistoryRequest{ChatId: chatID, TopicId: generalTopicID})
	if err != nil || !slices.ContainsFunc(hist.GetMessages(), func(m *appv1.Message) bool { return m.GetText() == "before topics" }) {
		t.Fatalf("General history = %v, %v", hist, err)
	}
	topicUpdates := 0
	for _, u := range h.logOf(admin) {
		if u.GetTopicChanged() != nil {
			topicUpdates++
		}
	}
	if topicUpdates != 5 { // General on, created, closed, hidden, renamed
		t.Fatalf("topic_changed updates = %d", topicUpdates)
	}
}

func TestReactionsEditsAndReports(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a, b := h.user("a"), h.user("b")
	chatID := h.group(a, b)
	seq := h.send(a, chatID, "hello").GetMessage().GetSeq()
	for _, bad := range []string{"ab", "👍👍", "1"} {
		if _, err := h.svc.SetReaction(ctx, b, chatID, seq, bad); codeOf(err) != connect.CodeInvalidArgument {
			t.Fatalf("reaction %q: %v", bad, err)
		}
	}
	if _, err := h.svc.SetReaction(ctx, b, chatID, seq, "❤️"); err != nil {
		t.Fatal(err)
	}
	r, err := h.svc.SetReaction(ctx, a, chatID, seq, "❤️")
	if err != nil || len(r.GetReactions()) != 1 || r.GetReactions()[0].GetCount() != 2 || !r.GetReactions()[0].GetChosen() {
		t.Fatalf("reactions = %v, %v", r, err)
	}
	r, err = h.svc.SetReaction(ctx, a, chatID, seq, "")
	if err != nil || r.GetReactions()[0].GetCount() != 1 || r.GetReactions()[0].GetChosen() {
		t.Fatalf("after removing mine = %v, %v", r, err)
	}
	// Text rules (ADR 0004).
	long := strings.Repeat("ạ", 4097)
	if _, err := h.svc.SendMessage(ctx, a, &appv1.SendMessageRequest{ChatId: chatID, Text: long}); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("over-long text: %v", err)
	}
	bad := []*appv1.MessageEntity{{Type: appv1.EntityType_ENTITY_TYPE_TEXT_LINK, Offset: 0, Length: 2, Url: "javascript:alert(1)"}}
	if _, err := h.svc.SendMessage(ctx, a, &appv1.SendMessageRequest{ChatId: chatID, Text: "hi", Entities: bad}); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("javascript: link: %v", err)
	}
	ok := []*appv1.MessageEntity{{Type: appv1.EntityType_ENTITY_TYPE_BOLD, Offset: 0, Length: 2}}
	edited, err := h.svc.EditMessage(ctx, a, &appv1.EditMessageRequest{ChatId: chatID, Seq: seq, Text: "😀 bold", Entities: ok})
	if err != nil || edited.GetMessage().GetEditVersion() != 1 || !proto.Equal(edited.GetMessage().GetEntities()[0], ok[0]) {
		t.Fatalf("edit = %v, %v", edited, err)
	}
	// Reports keep the reported text even if it is deleted later.
	if err := h.svc.Report(ctx, b, &appv1.ReportRequest{Target: &appv1.ReportRequest_Messages{Messages: &appv1.ReportedMessages{
		ChatId: chatID, Seqs: []int64{seq},
	}}, Reason: appv1.ReportReason_REPORT_REASON_SPAM, Comment: "spam"}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.DeleteMessages(ctx, a, chatID, []int64{seq}, true); err != nil {
		t.Fatal(err)
	}
	var evidence string
	if err := h.st.Pool().QueryRow(ctx, `SELECT evidence::text FROM reports WHERE reporter_id = $1`, b).Scan(&evidence); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(evidence, "😀 bold") {
		t.Fatalf("evidence = %s", evidence)
	}
	if err := h.svc.Report(ctx, b, &appv1.ReportRequest{Target: &appv1.ReportRequest_UserId{UserId: a}}); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("report without a reason: %v", err)
	}
}

func kindOf(u *appv1.Update) string {
	if u.GetKind() == nil {
		return "empty"
	}
	name := string(u.ProtoReflect().WhichOneof(u.ProtoReflect().Descriptor().Oneofs().ByName("kind")).Message().Name())
	return strings.TrimPrefix(name, "Update")
}
