package chat

import (
	"context"
	"slices"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"connectrpc.com/connect"
)

func reactorIDs(resp *appv1.GetMessageReactionsResponse) []int64 {
	var ids []int64
	for _, r := range resp.GetReactors() {
		ids = append(ids, r.GetUserId())
	}
	return ids
}

func TestMessageReactionsList(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a, b, c, d, stranger := h.user("a"), h.user("b"), h.user("c"), h.user("d"), h.user("stranger")
	chatID := h.group(a, b, c, d)
	seq := h.send(a, chatID, "react to me").GetMessage().GetSeq()
	for _, r := range []struct {
		user  int64
		emoji string
	}{{b, "👍"}, {c, "👍"}, {d, "❤️"}} {
		if _, err := h.svc.SetReaction(ctx, r.user, chatID, seq, r.emoji); err != nil {
			t.Fatal(err)
		}
	}
	list := func(me int64, emoji, cursor string, limit int32) (*appv1.GetMessageReactionsResponse, error) {
		return h.svc.GetMessageReactions(ctx, me, &appv1.GetMessageReactionsRequest{
			ChatId: chatID, Seq: seq, Emoji: emoji, Cursor: cursor, Limit: limit,
		})
	}
	all, err := list(a, "", "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if got := reactorIDs(all); !slices.Equal(got, []int64{d, c, b}) || all.GetReactors()[0].GetEmoji() != "❤️" ||
		all.GetReactors()[0].GetDate() == 0 || len(all.GetUsers()) != 3 || all.GetNextCursor() != "" {
		t.Fatalf("all reactions = %v", all)
	}
	// One emoji, one per page.
	var paged []int64
	cursor := ""
	for range 5 {
		page, err := list(b, "👍", cursor, 1)
		if err != nil {
			t.Fatal(err)
		}
		paged = append(paged, reactorIDs(page)...)
		if cursor = page.GetNextCursor(); cursor == "" {
			break
		}
	}
	if !slices.Equal(paged, []int64{c, b}) {
		t.Fatalf("paged 👍 = %v", paged)
	}
	if _, err := list(a, "x", "", 0); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("bad emoji: %v", err)
	}
	if _, err := list(a, "", "bad", 0); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("bad cursor: %v", err)
	}
	if _, err := list(stranger, "", "", 0); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("non-member lists: %v", err)
	}
	// Hidden for the caller: as if it did not exist.
	if _, err := h.svc.DeleteMessages(ctx, b, chatID, []int64{seq}, false); err != nil {
		t.Fatal(err)
	}
	if _, err := list(b, "", "", 0); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("hidden message: %v", err)
	}
	// Before a newcomer's history: invisible.
	if _, err := h.svc.SetHistoryVisibility(ctx, a, chatID, appv1.HistoryVisibility_HISTORY_VISIBILITY_SINCE_JOIN); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.AddMembers(ctx, a, chatID, []int64{stranger}); err != nil {
		t.Fatal(err)
	}
	if _, err := list(stranger, "", "", 0); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("newcomer lists old reactions: %v", err)
	}
	// Former members see no current reactions.
	if _, err := h.svc.LeaveChat(ctx, c, chatID, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := list(c, "", "", 0); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("former member lists: %v", err)
	}
	// Deleted for everyone.
	if _, err := h.svc.DeleteMessages(ctx, a, chatID, []int64{seq}, true); err != nil {
		t.Fatal(err)
	}
	if _, err := list(a, "", "", 0); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("deleted message: %v", err)
	}
}

func TestChannelReactionsAdminsOnly(t *testing.T) {
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
	seq := h.send(owner, chatID, "post").GetMessage().GetSeq()
	if _, err := h.svc.SetReaction(ctx, sub, chatID, seq, "🔥"); err != nil {
		t.Fatal(err)
	}
	req := &appv1.GetMessageReactionsRequest{ChatId: chatID, Seq: seq}
	if _, err := h.svc.GetMessageReactions(ctx, sub, req); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("subscriber lists reactors: %v", err)
	}
	if resp, err := h.svc.GetMessageReactions(ctx, owner, req); err != nil || !slices.Equal(reactorIDs(resp), []int64{sub}) {
		t.Fatalf("owner lists = %v, %v", resp, err)
	}
}

func TestBlockedUsersList(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	me, b, c, d, other := h.user("me"), h.user("b"), h.user("c"), h.user("d"), h.user("other")
	for _, u := range []int64{b, c, d} {
		if err := h.svc.Block(ctx, me, u); err != nil {
			t.Fatal(err)
		}
	}
	if err := h.svc.Block(ctx, other, me); err != nil {
		t.Fatal(err)
	}
	var got []int64
	cursor := ""
	for range 5 {
		page, err := h.svc.GetBlockedUsers(ctx, me, cursor, 2)
		if err != nil {
			t.Fatal(err)
		}
		for _, x := range page.GetBlocked() {
			if x.GetBlockedAt() == 0 {
				t.Fatalf("blocked_at missing: %v", x)
			}
			got = append(got, x.GetUserId())
		}
		for _, u := range page.GetUsers() {
			if !u.GetIsBlocked() {
				t.Fatalf("user not marked blocked: %v", u)
			}
		}
		if cursor = page.GetNextCursor(); cursor == "" {
			break
		}
	}
	if !slices.Equal(got, []int64{d, c, b}) {
		t.Fatalf("blocked = %v", got)
	}
	if err := h.svc.Unblock(ctx, me, c); err != nil {
		t.Fatal(err)
	}
	page, err := h.svc.GetBlockedUsers(ctx, me, "", 0)
	if err != nil || len(page.GetBlocked()) != 2 || slices.ContainsFunc(page.GetBlocked(), func(x *appv1.BlockedUser) bool { return x.GetUserId() == c }) {
		t.Fatalf("after unblock = %v, %v", page, err)
	}
	// Who blocked me is never listed to me.
	if page, err := h.svc.GetBlockedUsers(ctx, b, "", 0); err != nil || len(page.GetBlocked()) != 0 {
		t.Fatalf("blocked user's own list = %v, %v", page, err)
	}
	if _, err := h.svc.GetBlockedUsers(ctx, me, "%%", 0); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("bad cursor: %v", err)
	}
}

func TestContactsCarryAddedAt(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	me, b, c := h.user("me"), h.user("b"), h.user("c")
	h.group(me, b, c)
	for _, u := range []int64{c, b} {
		if _, err := h.svc.AddContact(ctx, me, &appv1.AddContactRequest{Target: &appv1.AddContactRequest_UserId{UserId: u}}); err != nil {
			t.Fatal(err)
		}
	}
	resp, err := h.svc.GetContacts(ctx, me, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.GetContacts()) != 2 || len(resp.GetUsers()) != 2 {
		t.Fatalf("contacts = %v", resp)
	}
	for i, x := range resp.GetContacts() {
		if x.GetUserId() != resp.GetUsers()[i].GetId() || x.GetAddedAt() == 0 {
			t.Fatalf("contact %d = %v, user %v", i, x, resp.GetUsers()[i])
		}
	}
}

func failureReasons(resp interface {
	GetFailures() []*appv1.AddMemberFailure
},
) map[int64]appv1.AddMemberFailureReason {
	out := map[int64]appv1.AddMemberFailureReason{}
	for _, f := range resp.GetFailures() {
		out[f.GetUserId()] = f.GetReason()
	}
	return out
}

func TestAddMembersReasons(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.ChatMembersMax = 6 })
	ctx := context.Background()
	owner, member := h.user("owner"), h.user("member")
	private, blocker, banned, already, fine, late := h.user("private"), h.user("blocker"), h.user("banned"), h.user("already"), h.user("fine"), h.user("late")
	h.defaultPrivacy(private)
	if err := h.svc.Block(ctx, blocker, member); err != nil {
		t.Fatal(err)
	}
	chatID := h.group(owner, member, banned, already)
	if _, err := h.svc.RemoveMember(ctx, owner, chatID, banned, true); err != nil {
		t.Fatal(err)
	}
	ghost := int64(1<<53 - 1)
	resp, err := h.svc.AddMembers(ctx, member, chatID, []int64{private, blocker, banned, already, ghost, fine, late})
	if err != nil {
		t.Fatal(err)
	}
	// owner, member and already leave room for 3 of the cap of 6: fine and
	// late join, nobody is refused for size yet.
	want := map[int64]appv1.AddMemberFailureReason{
		private: appv1.AddMemberFailureReason_ADD_MEMBER_FAILURE_REASON_PRIVACY_ADD_TO_GROUPS,
		blocker: appv1.AddMemberFailureReason_ADD_MEMBER_FAILURE_REASON_BLOCKED,
		banned:  appv1.AddMemberFailureReason_ADD_MEMBER_FAILURE_REASON_BANNED,
		already: appv1.AddMemberFailureReason_ADD_MEMBER_FAILURE_REASON_ALREADY_MEMBER,
		ghost:   appv1.AddMemberFailureReason_ADD_MEMBER_FAILURE_REASON_NOT_FOUND,
	}
	got := failureReasons(resp)
	if len(got) != len(want) {
		t.Fatalf("failures = %v", resp.GetFailures())
	}
	for id, reason := range want {
		if got[id] != reason {
			t.Fatalf("user %d: %v, want %v (all %v)", id, got[id], reason, got)
		}
	}
	// The legacy field keeps its meaning: refusals, not members already.
	legacy := []int64{private, blocker, banned, ghost}
	slices.Sort(legacy)
	if !slices.Equal(resp.GetFailedUserIds(), legacy) {
		t.Fatalf("failed_user_ids = %v, want %v", resp.GetFailedUserIds(), legacy)
	}
	// The member limit: 5 members now, room for one more.
	x, y := h.user("x"), h.user("y")
	resp, err = h.svc.AddMembers(ctx, owner, chatID, []int64{x, y})
	if err != nil {
		t.Fatal(err)
	}
	if got := failureReasons(resp); len(got) != 1 || got[y] != appv1.AddMemberFailureReason_ADD_MEMBER_FAILURE_REASON_TOO_MANY {
		t.Fatalf("over the limit: %v", resp.GetFailures())
	}
	link, err := h.svc.ExportInviteLink(ctx, owner, chatID, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.JoinByInvite(ctx, y, link.GetLink()); codeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("join a full chat: %v", err)
	}
	// CreateGroup reports reasons too.
	cg, err := h.svc.CreateGroup(ctx, owner, "g", []int64{private, fine}, false)
	if err != nil {
		t.Fatal(err)
	}
	if got := failureReasons(cg); len(got) != 1 || got[private] != appv1.AddMemberFailureReason_ADD_MEMBER_FAILURE_REASON_PRIVACY_ADD_TO_GROUPS ||
		!slices.Equal(cg.GetFailedUserIds(), []int64{private}) {
		t.Fatalf("CreateGroup failures = %v", cg.GetFailures())
	}
}
