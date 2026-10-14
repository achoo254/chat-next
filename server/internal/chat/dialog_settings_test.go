package chat

import (
	"context"
	"slices"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"connectrpc.com/connect"
)

// dialogOf returns my dialog of the chat from GetDialogs (nil when absent),
// with the pinned chat ids of the first page.
func (h *harness) dialogOf(me, chatID int64) (*appv1.Dialog, []int64) {
	h.t.Helper()
	resp, err := h.svc.GetDialogs(context.Background(), me, "", 0)
	if err != nil {
		h.t.Fatal(err)
	}
	for _, d := range resp.GetDialogs() {
		if d.GetChatId() == chatID {
			return d, resp.GetPinnedChatIds()
		}
	}
	return nil, resp.GetPinnedChatIds()
}

func dialogIDs(resp *appv1.GetDialogsResponse) []int64 {
	var ids []int64
	for _, d := range resp.GetDialogs() {
		ids = append(ids, d.GetChatId())
	}
	return ids
}

func TestDialogMute(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a, b, stranger := h.user("a"), h.user("b"), h.user("stranger")
	chatID := h.group(a, b)
	start := time.Now().Unix()
	resp, err := h.svc.SetDialogMute(ctx, a, chatID, 3600, false)
	if err != nil {
		t.Fatal(err)
	}
	if until := resp.GetMuteUntil(); until < start+3600 || until > time.Now().Unix()+3600 {
		t.Fatalf("mute_until = %d", until)
	}
	if resp.GetAck().GetPts() == 0 {
		t.Fatalf("ack = %v", resp.GetAck())
	}
	if d, _ := h.dialogOf(a, chatID); d.GetMuteUntil() != resp.GetMuteUntil() {
		t.Fatalf("dialog = %v", d)
	}
	// Only the caller's dialog changes.
	if d, _ := h.dialogOf(b, chatID); d.GetMuteUntil() != 0 {
		t.Fatalf("other member's dialog muted: %v", d)
	}
	// The caller's other sessions learn it in realtime and from the log.
	h.drain()
	var got []*appv1.UpdateDialogMute
	for _, u := range h.sink.updatesOf(a) {
		if m := u.GetDialogMute(); m != nil {
			got = append(got, m)
		}
	}
	if len(got) != 1 || got[0].GetChatId() != chatID || got[0].GetMuteUntil() != resp.GetMuteUntil() {
		t.Fatalf("realtime dialog_mute = %v", got)
	}
	for _, u := range h.sink.updatesOf(b) {
		if u.GetDialogMute() != nil {
			t.Fatalf("other member got %v", u)
		}
	}
	if log := h.logOf(a); log[len(log)-1].GetDialogMute().GetMuteUntil() != resp.GetMuteUntil() {
		t.Fatalf("log tail = %v", log[len(log)-1])
	}

	forever, err := h.svc.SetDialogMute(ctx, a, chatID, 0, true)
	if err != nil || forever.GetMuteUntil() != muteForever {
		t.Fatalf("forever = %v, %v", forever, err)
	}
	off, err := h.svc.SetDialogMute(ctx, a, chatID, 0, false)
	if err != nil || off.GetMuteUntil() != 0 {
		t.Fatalf("unmute = %v, %v", off, err)
	}
	if d, _ := h.dialogOf(a, chatID); d.GetMuteUntil() != 0 {
		t.Fatalf("dialog after unmute = %v", d)
	}
	for _, bad := range []int32{-1, muteDurationMax + 1} {
		if _, err := h.svc.SetDialogMute(ctx, a, chatID, bad, false); codeOf(err) != connect.CodeInvalidArgument {
			t.Fatalf("duration %d: %v", bad, err)
		}
	}
	if _, err := h.svc.SetDialogMute(ctx, stranger, chatID, 3600, false); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("non-member mutes: %v", err)
	}
	// An ended mute reads as not muted.
	if _, err := h.st.Pool().Exec(ctx, `UPDATE chat_members SET mute_until = $3 WHERE chat_id = $1 AND user_id = $2`,
		chatID, a, time.Now().Unix()-1); err != nil {
		t.Fatal(err)
	}
	if d, _ := h.dialogOf(a, chatID); d.GetMuteUntil() != 0 {
		t.Fatalf("expired mute = %v", d)
	}
}

func TestPinnedDialogs(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a, b := h.user("a"), h.user("b")
	chats := make([]int64, pinnedDialogsMax+1)
	for i := range chats {
		chats[i] = h.group(a, b)
	}
	// The newest chat is first by activity; pinning lifts older ones above it.
	if _, err := h.svc.SetDialogPinned(ctx, a, chats[0], true); err != nil {
		t.Fatal(err)
	}
	resp, err := h.svc.SetDialogPinned(ctx, a, chats[1], true)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(resp.GetPinnedChatIds(), []int64{chats[1], chats[0]}) {
		t.Fatalf("pinned = %v", resp.GetPinnedChatIds())
	}
	page, err := h.svc.GetDialogs(ctx, a, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	ids := dialogIDs(page)
	if !slices.Equal(ids[:2], []int64{chats[1], chats[0]}) || !slices.Equal(page.GetPinnedChatIds(), ids[:2]) ||
		!page.GetDialogs()[0].GetPinned() || page.GetDialogs()[2].GetPinned() || len(ids) != len(chats) {
		t.Fatalf("dialogs = %v pinned %v", ids, page.GetPinnedChatIds())
	}
	// Pinned chats are in the first page on top of the limit, and never in
	// later pages.
	first, err := h.svc.GetDialogs(ctx, a, "", 2)
	if err != nil {
		t.Fatal(err)
	}
	if got := dialogIDs(first); len(got) != 4 || first.GetNextCursor() == "" {
		t.Fatalf("first page = %v", got)
	}
	seen := dialogIDs(first)
	for cursor := first.GetNextCursor(); cursor != ""; {
		next, err := h.svc.GetDialogs(ctx, a, cursor, 2)
		if err != nil {
			t.Fatal(err)
		}
		if len(next.GetPinnedChatIds()) != 0 {
			t.Fatalf("later page lists pins: %v", next.GetPinnedChatIds())
		}
		seen = append(seen, dialogIDs(next)...)
		cursor = next.GetNextCursor()
	}
	slices.Sort(seen)
	if want := slices.Sorted(slices.Values(chats)); !slices.Equal(seen, want) {
		t.Fatalf("paged dialogs = %v, want %v", seen, want)
	}
	// Pins are per user.
	if _, pinned := h.dialogOf(b, chats[0]); len(pinned) != 0 {
		t.Fatalf("other user's pins = %v", pinned)
	}
	// Reorder must name exactly the pinned chats.
	if _, err := h.svc.ReorderPinnedDialogs(ctx, a, []int64{chats[0]}); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("partial reorder: %v", err)
	}
	if _, err := h.svc.ReorderPinnedDialogs(ctx, a, []int64{chats[0], chats[0]}); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("duplicate reorder: %v", err)
	}
	re, err := h.svc.ReorderPinnedDialogs(ctx, a, []int64{chats[0], chats[1]})
	if err != nil || !slices.Equal(re.GetPinnedChatIds(), []int64{chats[0], chats[1]}) {
		t.Fatalf("reorder = %v, %v", re, err)
	}
	// The limit.
	for _, id := range chats[2:pinnedDialogsMax] {
		if _, err := h.svc.SetDialogPinned(ctx, a, id, true); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := h.svc.SetDialogPinned(ctx, a, chats[pinnedDialogsMax], true); codeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("pin over the limit: %v", err)
	}
	// Pinning twice changes nothing; leaving drops the pin.
	if again, err := h.svc.SetDialogPinned(ctx, a, chats[0], true); err != nil || len(again.GetPinnedChatIds()) != pinnedDialogsMax {
		t.Fatalf("pin again = %v, %v", again, err)
	}
	if _, err := h.svc.SetAdmin(ctx, a, chats[2], b, true); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.LeaveChat(ctx, a, chats[2], 0); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.SetDialogPinned(ctx, a, chats[pinnedDialogsMax], true); err != nil {
		t.Fatalf("pin after leaving a pinned chat: %v", err)
	}
	un, err := h.svc.SetDialogPinned(ctx, a, chats[0], false)
	if err != nil || slices.Contains(un.GetPinnedChatIds(), chats[0]) {
		t.Fatalf("unpin = %v, %v", un, err)
	}
	// Every session of the user follows the order through pinned_dialogs.
	h.drain()
	var last *appv1.UpdatePinnedDialogs
	for _, u := range h.sink.updatesOf(a) {
		if p := u.GetPinnedDialogs(); p != nil {
			last = p
		}
	}
	if last == nil || !slices.Equal(last.GetChatIds(), un.GetPinnedChatIds()) {
		t.Fatalf("last pinned_dialogs = %v, want %v", last, un.GetPinnedChatIds())
	}
	logged := h.logOf(a)
	var fromLog *appv1.UpdatePinnedDialogs
	for _, u := range logged {
		if p := u.GetPinnedDialogs(); p != nil {
			fromLog = p
		}
	}
	if !slices.Equal(fromLog.GetChatIds(), un.GetPinnedChatIds()) {
		t.Fatalf("log pinned_dialogs = %v", fromLog)
	}
}

func TestDeleteGroupForEveryone(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner, admin, member, left := h.user("owner"), h.user("admin"), h.user("member"), h.user("left")
	chatID := h.group(owner, admin, member, left)
	if _, err := h.svc.SetAdmin(ctx, owner, chatID, admin, true); err != nil {
		t.Fatal(err)
	}
	h.send(member, chatID, "secret")
	if _, err := h.svc.LeaveChat(ctx, left, chatID, 0); err != nil {
		t.Fatal(err)
	}
	link, err := h.svc.ExportInviteLink(ctx, owner, chatID, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.SetDialogPinned(ctx, member, chatID, true); err != nil {
		t.Fatal(err)
	}
	for _, who := range []int64{admin, member} {
		if _, err := h.svc.DeleteChat(ctx, who, chatID); codeOf(err) != connect.CodePermissionDenied {
			t.Fatalf("non-owner deletes: %v", err)
		}
	}
	if _, err := h.svc.DeleteChat(ctx, owner, chatID); err != nil {
		t.Fatal(err)
	}
	h.drain()
	for _, u := range []int64{owner, admin, member} {
		var deleted *appv1.UpdateChatDeleted
		for _, x := range h.sink.updatesOf(u) {
			if d := x.GetChatDeleted(); d != nil {
				deleted = d
			}
		}
		if deleted.GetChatId() != chatID || !deleted.GetForEveryone() {
			t.Fatalf("user %d realtime chat_deleted = %v", u, deleted)
		}
		log := h.logOf(u)
		if d := log[len(log)-1].GetChatDeleted(); d.GetChatId() != chatID {
			t.Fatalf("user %d log tail = %v", u, log[len(log)-1])
		}
		// Nothing of the chat renders any more, not even old log entries.
		for _, x := range log {
			if m := x.GetMessageNew().GetMessage(); m.GetChatId() == chatID {
				t.Fatalf("user %d still renders %v", u, m)
			}
		}
		if d, pinned := h.dialogOf(u, chatID); d != nil || slices.Contains(pinned, chatID) {
			t.Fatalf("user %d still lists the chat", u)
		}
		if _, _, err := h.svc.GetChat(ctx, u, chatID); codeOf(err) != connect.CodeNotFound {
			t.Fatalf("user %d GetChat: %v", u, err)
		}
		if _, err := h.svc.GetHistory(ctx, u, &appv1.GetHistoryRequest{ChatId: chatID}); codeOf(err) != connect.CodeNotFound {
			t.Fatalf("user %d GetHistory: %v", u, err)
		}
	}
	// A former member gets no update and loses the history they kept.
	for _, x := range h.sink.updatesOf(left) {
		if x.GetChatDeleted() != nil {
			t.Fatalf("former member got %v", x)
		}
	}
	if _, err := h.svc.GetHistory(ctx, left, &appv1.GetHistoryRequest{ChatId: chatID}); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("former member GetHistory: %v", err)
	}
	if _, err := h.svc.JoinByInvite(ctx, left, link.GetLink()); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("join a deleted chat: %v", err)
	}
	if _, err := h.svc.SendMessage(ctx, owner, &appv1.SendMessageRequest{ChatId: chatID, Text: "x"}); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("send to a deleted chat: %v", err)
	}
	// The purge removes the messages; it is idempotent.
	n, err := h.svc.purgeDeletedChats(ctx)
	if err != nil || n != 1 {
		t.Fatalf("purge = %d, %v", n, err)
	}
	var left0 int
	if err := h.st.Pool().QueryRow(ctx, `SELECT count(*) FROM messages WHERE chat_id = $1`, chatID).Scan(&left0); err != nil || left0 != 0 {
		t.Fatalf("messages after purge = %d, %v", left0, err)
	}
	if n, err := h.svc.purgeDeletedChats(ctx); err != nil || n != 0 {
		t.Fatalf("second purge = %d, %v", n, err)
	}
}

func TestDeleteChannelAndForgetSockets(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner, sub := h.user("owner"), h.user("sub")
	ch, err := h.svc.CreateChannel(ctx, owner, "news", "")
	if err != nil {
		t.Fatal(err)
	}
	chatID := ch.GetChat().GetId()
	if _, err := h.svc.AddMembers(ctx, owner, chatID, []int64{sub}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.DeleteChat(ctx, sub, chatID); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("subscriber deletes: %v", err)
	}
	if _, err := h.svc.DeleteChat(ctx, owner, chatID); err != nil {
		t.Fatal(err)
	}
	h.drain()
	h.sink.mu.Lock()
	forgot := slices.Contains(h.sink.forget, [2]int64{sub, chatID}) && slices.Contains(h.sink.forget, [2]int64{owner, chatID})
	h.sink.mu.Unlock()
	if !forgot {
		t.Fatalf("sockets not told to forget: %v", h.sink.forget)
	}
}

func TestDeletePrivateChatForMe(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a, b := h.user("a"), h.user("b")
	chat, _, err := h.svc.CreatePrivate(ctx, a, b)
	if err != nil {
		t.Fatal(err)
	}
	chatID := chat.GetId()
	old := h.send(b, chatID, "old").GetMessage().GetSeq()
	if _, err := h.svc.SetDialogPinned(ctx, a, chatID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.DeleteChat(ctx, a, chatID); err != nil {
		t.Fatal(err)
	}
	h.drain()
	var deleted *appv1.UpdateChatDeleted
	for _, u := range h.sink.updatesOf(a) {
		if d := u.GetChatDeleted(); d != nil {
			deleted = d
		}
	}
	if deleted.GetChatId() != chatID || deleted.GetForEveryone() {
		t.Fatalf("chat_deleted = %v", deleted)
	}
	for _, u := range h.sink.updatesOf(b) {
		if u.GetChatDeleted() != nil {
			t.Fatalf("peer got %v", u)
		}
	}
	if d, pinned := h.dialogOf(a, chatID); d != nil || len(pinned) != 0 {
		t.Fatalf("deleted private chat still listed: %v %v", d, pinned)
	}
	if d, _ := h.dialogOf(b, chatID); d == nil {
		t.Fatal("the peer lost the chat")
	}
	hist, err := h.svc.GetHistory(ctx, a, &appv1.GetHistoryRequest{ChatId: chatID})
	if err != nil || len(hist.GetMessages()) != 0 {
		t.Fatalf("history after delete = %v, %v", hist, err)
	}
	// Old messages stay out of reach: no edit or reaction reaches me.
	if _, err := h.svc.SetReaction(ctx, a, chatID, old, "👍"); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("react to a cleared message: %v", err)
	}
	// A new message brings the chat back with only what came after.
	h.send(b, chatID, "new")
	d, _ := h.dialogOf(a, chatID)
	if d == nil || d.GetUnreadCount() != 1 {
		t.Fatalf("dialog after a new message = %v", d)
	}
	hist, err = h.svc.GetHistory(ctx, a, &appv1.GetHistoryRequest{ChatId: chatID})
	if err != nil || len(hist.GetMessages()) != 1 || hist.GetMessages()[0].GetText() != "new" {
		t.Fatalf("history after a new message = %v, %v", hist, err)
	}
}

func TestLeaveChatNamingNewOwner(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner, first, second, member := h.user("owner"), h.user("first"), h.user("second"), h.user("member")
	chatID := h.group(owner, first, second, member)
	for _, a := range []int64{first, second} {
		if _, err := h.svc.SetAdmin(ctx, owner, chatID, a, true); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := h.svc.LeaveChat(ctx, owner, chatID, member); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("hand over to a plain member: %v", err)
	}
	if _, err := h.svc.LeaveChat(ctx, owner, chatID, h.user("stranger")); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("hand over to a stranger: %v", err)
	}
	if _, err := h.svc.LeaveChat(ctx, first, chatID, second); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("an admin names an owner: %v", err)
	}
	if _, err := h.svc.LeaveChat(ctx, owner, chatID, owner); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("owner names themselves: %v", err)
	}
	// The second admin, not the longest-serving one.
	if _, err := h.svc.LeaveChat(ctx, owner, chatID, second); err != nil {
		t.Fatal(err)
	}
	chat, _, err := h.svc.GetChat(ctx, second, chatID)
	if err != nil || chat.GetMyRole() != appv1.MemberRole_MEMBER_ROLE_OWNER {
		t.Fatalf("new owner = %v, %v", chat, err)
	}
	if chat, _, _ := h.svc.GetChat(ctx, first, chatID); chat.GetMyRole() != appv1.MemberRole_MEMBER_ROLE_ADMIN {
		t.Fatalf("first admin became %v", chat.GetMyRole())
	}
}

func TestCommonChats(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	me, peer, other := h.user("me"), h.user("peer"), h.user("other")
	g1 := h.group(me, peer)
	g2 := h.group(peer, me)
	h.group(me, other)
	leftGroup := h.group(me, peer)
	if _, err := h.svc.LeaveChat(ctx, peer, leftGroup, 0); err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.svc.CreatePrivate(ctx, me, peer); err != nil {
		t.Fatal(err)
	}
	// A channel I administer where peer subscribes counts; one where I am
	// only a subscriber does not (its members are private).
	mine, err := h.svc.CreateChannel(ctx, me, "mine", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.AddMembers(ctx, me, mine.GetChat().GetId(), []int64{peer}); err != nil {
		t.Fatal(err)
	}
	theirs, err := h.svc.CreateChannel(ctx, other, "theirs", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.AddMembers(ctx, other, theirs.GetChat().GetId(), []int64{me, peer}); err != nil {
		t.Fatal(err)
	}
	want := []int64{g1, g2, mine.GetChat().GetId()}
	slices.Sort(want)
	var got []int64
	cursor := ""
	for {
		resp, err := h.svc.GetCommonChats(ctx, me, peer, cursor, 2)
		if err != nil {
			t.Fatal(err)
		}
		if resp.GetCount() != int32(len(want)) {
			t.Fatalf("count = %d", resp.GetCount())
		}
		for _, c := range resp.GetChats() {
			got = append(got, c.GetId())
		}
		if cursor = resp.GetNextCursor(); cursor == "" {
			break
		}
	}
	if !slices.Equal(got, want) {
		t.Fatalf("common chats = %v, want %v", got, want)
	}
	// From the subscriber's side the admin's channel is not visible either.
	resp, err := h.svc.GetCommonChats(ctx, peer, me, "", 0)
	if err != nil || resp.GetCount() != 2 {
		t.Fatalf("peer's view = %v, %v", resp, err)
	}
	if _, err := h.svc.GetCommonChats(ctx, me, me, "", 0); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("common chats with myself: %v", err)
	}
	if _, err := h.svc.GetCommonChats(ctx, me, peer, "x", 0); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("bad cursor: %v", err)
	}
}
