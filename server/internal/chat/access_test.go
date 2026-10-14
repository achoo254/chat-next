package chat

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"connectrpc.com/connect"
)

// defaultPrivacy drops the harness's "anyone may add me" row, leaving the
// defaults (add_to_groups and last_seen: contacts).
func (h *harness) defaultPrivacy(userID int64) {
	h.t.Helper()
	if _, err := h.st.Pool().Exec(context.Background(), `DELETE FROM privacy_settings WHERE user_id = $1`, userID); err != nil {
		h.t.Fatal(err)
	}
}

// texts lists the message texts carried by updates.
func texts(updates []*appv1.Update) []string {
	var out []string
	for _, u := range updates {
		if m := u.GetMessageNew().GetMessage(); m != nil {
			out = append(out, m.GetText())
		}
		if m := u.GetMessageEdit().GetMessage(); m != nil {
			out = append(out, m.GetText())
		}
	}
	return out
}

func TestNewcomerNeverGetsHistoryBeforeJoining(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a, b, c := h.user("a"), h.user("b"), h.user("c")
	chatID := h.group(a, b)
	old := h.send(a, chatID, "old secret").GetMessage().GetSeq()
	if _, err := h.svc.SetHistoryVisibility(ctx, a, chatID, appv1.HistoryVisibility_HISTORY_VISIBILITY_SINCE_JOIN); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.AddMembers(ctx, a, chatID, []int64{c}); err != nil {
		t.Fatal(err)
	}
	h.drain()
	before := len(h.sink.updatesOf(c))
	// Edits, link previews (the same rewrite) and reactions of old messages
	// never reach the newcomer, in realtime or from the log.
	if _, err := h.svc.EditMessage(ctx, a, &appv1.EditMessageRequest{ChatId: chatID, Seq: old, Text: "old secret, edited"}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.SetReaction(ctx, b, chatID, old, "👍"); err != nil {
		t.Fatal(err)
	}
	h.drain()
	if got := h.sink.updatesOf(c)[before:]; len(got) != 0 {
		t.Fatalf("newcomer got updates about history before joining: %v", got)
	}
	for _, s := range texts(h.logOf(c)) {
		if strings.Contains(s, "old secret") {
			t.Fatalf("newcomer's log carries %q", s)
		}
	}
	// Rendering itself refuses, whatever log the update comes from (a large
	// chat's log reaches every member).
	edit := &appv1.Update{Kind: &appv1.Update_MessageEdit{MessageEdit: &appv1.UpdateMessageEdit{Message: &appv1.Message{ChatId: chatID, Seq: old}}}}
	reaction := &appv1.Update{Kind: &appv1.Update_Reaction{Reaction: &appv1.UpdateReaction{ChatId: chatID, Seq: old}}}
	frames, err := h.svc.renderFrames(ctx, h.st.Pool(), []int64{c}, map[int64][]*appv1.Update{c: {edit, reaction}}, true)
	if err != nil {
		t.Fatal(err)
	}
	for _, u := range frames[c].GetUpdates() {
		if u.GetKind() != nil {
			t.Fatalf("rendered for the newcomer: %v", u)
		}
	}
	// Read receipts of an invisible message do not exist for them either.
	if _, err := h.svc.GetMessageReaders(ctx, c, chatID, old); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("readers of a message before joining: %v", err)
	}
}

func TestFormerMemberSeesNothingNewerOrChanged(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a, b, c := h.user("a"), h.user("b"), h.user("c")
	chatID := h.group(a, b, c)
	kept := h.send(a, chatID, "kept as it was").GetMessage().GetSeq()
	changed := h.send(a, chatID, "draft").GetMessage().GetSeq()
	if _, err := h.svc.LeaveChat(ctx, b, chatID, 0); err != nil {
		t.Fatal(err)
	}
	// Commits after leaving: an edit and a new message.
	time.Sleep(5 * time.Millisecond)
	if _, err := h.svc.EditMessage(ctx, a, &appv1.EditMessageRequest{ChatId: chatID, Seq: changed, Text: "changed after b left"}); err != nil {
		t.Fatal(err)
	}
	h.send(a, chatID, "after b left")
	got := texts(h.logOf(b))
	if !slices.Contains(got, "kept as it was") {
		t.Fatalf("former member lost a message from their membership: %v", got)
	}
	for _, s := range got {
		if strings.Contains(s, "after b left") || s == "draft" {
			t.Fatalf("former member's log renders %q: %v", s, got)
		}
	}
	// The same rules hold for an update rendered now for b, e.g. a delivery
	// queued before b left.
	ref := func(seq int64) *appv1.Update {
		return &appv1.Update{Kind: &appv1.Update_MessageNew{MessageNew: &appv1.UpdateMessageNew{Message: &appv1.Message{ChatId: chatID, Seq: seq}}}}
	}
	frames, err := h.svc.renderFrames(ctx, h.st.Pool(), []int64{b}, map[int64][]*appv1.Update{b: {ref(kept), ref(changed)}}, false)
	if err != nil {
		t.Fatal(err)
	}
	if u := frames[b].GetUpdates(); u[0].GetMessageNew().GetMessage().GetText() != "kept as it was" || u[1].GetKind() != nil {
		t.Fatalf("rendered for the former member: %v", u)
	}
	// Someone who was never a member gets nothing at all.
	stranger := h.user("stranger")
	frames, err = h.svc.renderFrames(ctx, h.st.Pool(), []int64{stranger}, map[int64][]*appv1.Update{stranger: {ref(kept)}}, false)
	if err != nil || frames[stranger].GetUpdates()[0].GetKind() != nil {
		t.Fatalf("rendered for a stranger: %v, %v", frames[stranger], err)
	}
}

func TestLargeChatLogReachesOnlyCurrentMembers(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.LargeChatThreshold = 2 })
	ctx := context.Background()
	a, b, c := h.user("a"), h.user("b"), h.user("c")
	chatID := h.group(a, b, c)
	if ch, _, _ := h.svc.GetChat(ctx, a, chatID); ch.GetSyncMode() != appv1.SyncMode_SYNC_MODE_LARGE {
		t.Fatalf("chat is not large: %v", ch)
	}
	// b's socket still shows the chat after the removal.
	h.sink.mu.Lock()
	h.sink.viewers[chatID] = []int64{b, c}
	h.sink.mu.Unlock()
	if _, err := h.svc.RemoveMember(ctx, a, chatID, b, true); err != nil {
		t.Fatal(err)
	}
	h.drain()
	before := len(h.sink.updatesOf(b))
	h.send(a, chatID, "members only")
	h.drain()
	if got := h.sink.updatesOf(b)[before:]; len(got) != 0 {
		t.Fatalf("removed member got the chat's log: %v", got)
	}
	if got := texts(h.sink.updatesOf(c)); !slices.Contains(got, "members only") {
		t.Fatalf("member did not get the chat's log: %v", got)
	}
	if _, err := h.svc.GetChatDifference(ctx, b, &appv1.GetChatDifferenceRequest{ChatId: chatID, ServerEpoch: h.svc.Epoch()}); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("GetChatDifference of a removed member: %v", err)
	}
}

func TestContactsDecidePrivacy(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	x, a, y := h.user("x"), h.user("a"), h.user("y")
	h.defaultPrivacy(x)
	// x is in a group with a and y: sharing it no longer makes them contacts.
	h.group(x, a, y)
	if resp, err := h.svc.CreateGroup(ctx, a, "g", []int64{x}, false); err != nil || !slices.Equal(resp.GetFailedUserIds(), []int64{x}) {
		t.Fatalf("added to a group by a non-contact: %v, %v", resp, err)
	}
	if _, err := h.st.Pool().Exec(ctx, `UPDATE users SET last_seen_at = now() - interval '1 hour' WHERE id = $1`, x); err != nil {
		t.Fatal(err)
	}
	status := func(viewer int64) appv1.UserStatusKind {
		t.Helper()
		users, err := h.svc.GetUsers(ctx, viewer, []int64{x})
		if err != nil || len(users) != 1 {
			t.Fatalf("GetUsers = %v, %v", users, err)
		}
		return users[0].GetStatus().GetKind()
	}
	if k := status(a); k != appv1.UserStatusKind_USER_STATUS_KIND_RECENTLY {
		t.Fatalf("non-contact sees last seen %v", k)
	}
	// x lists a: a may add x and sees x's exact last seen; y still does not.
	if u, err := h.svc.AddContact(ctx, x, &appv1.AddContactRequest{Target: &appv1.AddContactRequest_UserId{UserId: a}}); err != nil || u.GetId() != a {
		t.Fatalf("AddContact = %v, %v", u, err)
	}
	if resp, err := h.svc.CreateGroup(ctx, a, "g", []int64{x}, false); err != nil || len(resp.GetFailedUserIds()) != 0 {
		t.Fatalf("contact adds x: %v, %v", resp, err)
	}
	if k := status(a); k != appv1.UserStatusKind_USER_STATUS_KIND_OFFLINE {
		t.Fatalf("contact sees last seen %v", k)
	}
	if k := status(y); k != appv1.UserStatusKind_USER_STATUS_KIND_RECENTLY {
		t.Fatalf("x's contact list leaked to y: %v", k)
	}
	// Being in someone else's list grants nothing over them.
	if _, err := h.svc.AddContact(ctx, a, &appv1.AddContactRequest{Target: &appv1.AddContactRequest_UserId{UserId: y}}); err != nil {
		t.Fatal(err)
	}
	list, err := h.svc.GetContacts(ctx, x, "", 0)
	if err != nil || len(list.GetUsers()) != 1 || list.GetUsers()[0].GetId() != a {
		t.Fatalf("x's contacts = %v, %v", list, err)
	}
	if err := h.svc.DeleteContact(ctx, x, a); err != nil {
		t.Fatal(err)
	}
	if k := status(a); k != appv1.UserStatusKind_USER_STATUS_KIND_RECENTLY {
		t.Fatalf("after DeleteContact, last seen %v", k)
	}
}

func TestAddContactRespectsFindSettings(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	me, open, hidden, stranger := h.user("me"), h.user("openuser"), h.user("hiddenuser"), h.user("stranger")
	nobody, everyone := appv1.PrivacyAudience_PRIVACY_AUDIENCE_NOBODY, appv1.PrivacyAudience_PRIVACY_AUDIENCE_EVERYONE
	if _, err := h.svc.SetPrivacy(ctx, hidden, &appv1.SetPrivacyRequest{FindByUsername: &nobody}); err != nil {
		t.Fatal(err)
	}
	for id, email := range map[int64]string{open: "open@example.test", hidden: "hidden@example.test"} {
		if _, err := h.st.Pool().Exec(ctx, `UPDATE users SET email = $2, email_verified = true WHERE id = $1`, id, email); err != nil {
			t.Fatal(err)
		}
	}
	add := func(req *appv1.AddContactRequest) (*appv1.User, error) { return h.svc.AddContact(ctx, me, req) }
	if u, err := add(&appv1.AddContactRequest{Target: &appv1.AddContactRequest_Username{Username: "@openuser"}}); err != nil || u.GetId() != open {
		t.Fatalf("by username = %v, %v", u, err)
	}
	// Neutral not-found: hidden by settings, unknown, by email under the
	// default (nobody), or by id without any relation.
	for name, req := range map[string]*appv1.AddContactRequest{
		"hidden username": {Target: &appv1.AddContactRequest_Username{Username: "hiddenuser"}},
		"unknown":         {Target: &appv1.AddContactRequest_Username{Username: "nosuchuser"}},
		"default email":   {Target: &appv1.AddContactRequest_Email{Email: "hidden@example.test"}},
		"unrelated id":    {Target: &appv1.AddContactRequest_UserId{UserId: stranger}},
	} {
		if _, err := add(req); codeOf(err) != connect.CodeNotFound {
			t.Fatalf("%s: %v", name, err)
		}
	}
	if _, err := h.svc.ResolveUsername(ctx, me, "hiddenuser"); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("ResolveUsername ignores find_by_username: %v", err)
	}
	if _, err := h.svc.SetPrivacy(ctx, hidden, &appv1.SetPrivacyRequest{FindByEmail: &everyone}); err != nil {
		t.Fatal(err)
	}
	if u, err := add(&appv1.AddContactRequest{Target: &appv1.AddContactRequest_Email{Email: "HIDDEN@example.test"}}); err != nil || u.GetId() != hidden {
		t.Fatalf("by allowed email = %v, %v", u, err)
	}
	page, err := h.svc.GetContacts(ctx, me, "", 1)
	if err != nil || len(page.GetUsers()) != 1 || page.GetNextCursor() == "" {
		t.Fatalf("first page = %v, %v", page, err)
	}
	rest, err := h.svc.GetContacts(ctx, me, page.GetNextCursor(), 1)
	if err != nil || len(rest.GetUsers()) != 1 || rest.GetUsers()[0].GetId() == page.GetUsers()[0].GetId() {
		t.Fatalf("second page = %v, %v", rest, err)
	}
	if _, err := add(&appv1.AddContactRequest{Target: &appv1.AddContactRequest_UserId{UserId: me}}); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("adding myself: %v", err)
	}
}

func TestGetUsersOnlyReturnsRelatedUsers(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	me, mate, listed, stranger := h.user("me"), h.user("mate"), h.user("listed"), h.user("stranger")
	h.group(me, mate)
	if _, err := h.st.Pool().Exec(ctx, `INSERT INTO contacts (tenant_id, owner_id, contact_id) VALUES ($1, $2, $3)`, testTenant, listed, me); err != nil {
		t.Fatal(err)
	}
	users, err := h.svc.GetUsers(ctx, me, []int64{me, mate, listed, stranger})
	if err != nil {
		t.Fatal(err)
	}
	var got []int64
	for _, u := range users {
		got = append(got, u.GetId())
	}
	if want := []int64{me, mate, listed}; !slices.Equal(got, want) {
		t.Fatalf("GetUsers = %v, want %v (stranger %d omitted)", got, want, stranger)
	}
}

func TestRemovalBansUntilAnAdminUnbans(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner, member, kicked, newcomer := h.user("owner"), h.user("member"), h.user("kicked"), h.user("newcomer")
	chatID := h.group(owner, member, kicked)
	ownerLink := inviteOf(t, h, owner, chatID)
	kickedLink := inviteOf(t, h, kicked, chatID)
	memberLink := inviteOf(t, h, member, chatID)
	if _, err := h.svc.RemoveMember(ctx, owner, chatID, kicked, true); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.JoinByInvite(ctx, kicked, ownerLink); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("banned user rejoins by link: %v", err)
	}
	if _, err := h.svc.CheckInvite(ctx, kicked, ownerLink); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("banned user checks a link: %v", err)
	}
	if resp, err := h.svc.AddMembers(ctx, member, chatID, []int64{kicked}); err != nil || !slices.Equal(resp.GetFailedUserIds(), []int64{kicked}) {
		t.Fatalf("non-admin re-adds a banned user: %v, %v", resp.GetFailures(), err)
	}
	// The removed user's own links died with the removal.
	if _, err := h.svc.JoinByInvite(ctx, newcomer, kickedLink); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("link of a removed member: %v", err)
	}
	banned, err := h.svc.GetBannedMembers(ctx, owner, chatID, "", 0)
	if err != nil || len(banned.GetMembers()) != 1 || banned.GetMembers()[0].GetUserId() != kicked || banned.GetMembers()[0].GetBannedBy() != owner {
		t.Fatalf("banned list = %v, %v", banned, err)
	}
	if _, err := h.svc.GetBannedMembers(ctx, member, chatID, "", 0); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("member lists bans: %v", err)
	}
	if err := h.svc.UnbanMember(ctx, member, chatID, kicked); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("member unbans: %v", err)
	}
	if err := h.svc.UnbanMember(ctx, owner, chatID, kicked); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.JoinByInvite(ctx, kicked, ownerLink); err != nil {
		t.Fatalf("rejoin after unban: %v", err)
	}
	// An admin adding a banned user lifts the ban.
	if _, err := h.svc.RemoveMember(ctx, owner, chatID, kicked, true); err != nil {
		t.Fatal(err)
	}
	if resp, err := h.svc.AddMembers(ctx, owner, chatID, []int64{kicked}); err != nil || len(resp.GetFailures()) != 0 {
		t.Fatalf("admin re-adds: %v, %v", resp.GetFailures(), err)
	}
	if b, _ := h.svc.GetBannedMembers(ctx, owner, chatID, "", 0); len(b.GetMembers()) != 0 {
		t.Fatalf("ban kept after an admin re-added: %v", b)
	}
	// A link stops working when its creator leaves (or may no longer invite).
	if _, err := h.svc.LeaveChat(ctx, member, chatID, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.JoinByInvite(ctx, newcomer, memberLink); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("link of a member who left: %v", err)
	}
	if _, err := h.svc.CheckInvite(ctx, newcomer, memberLink); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("check of a link whose creator left: %v", err)
	}
}

func TestChannelMembersAndOwnerLeaving(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner, admin, reader := h.user("owner"), h.user("admin"), h.user("reader")
	ch, err := h.svc.CreateChannel(ctx, owner, "news", "")
	if err != nil {
		t.Fatal(err)
	}
	chatID := ch.GetChat().GetId()
	if _, err := h.svc.AddMembers(ctx, owner, chatID, []int64{admin, reader}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.GetMembers(ctx, reader, chatID, "", "", 0); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("channel reader lists members: %v", err)
	}
	if list, err := h.svc.GetMembers(ctx, owner, chatID, "", "", 0); err != nil || len(list.GetMembers()) != 3 {
		t.Fatalf("owner lists members: %v, %v", list, err)
	}
	// Without an admin the owner cannot leave members behind.
	_, err = h.svc.LeaveChat(ctx, owner, chatID, 0)
	if codeOf(err) != connect.CodeFailedPrecondition || !strings.Contains(err.Error(), "owner_needs_admin") {
		t.Fatalf("owner leaves without an admin: %v", err)
	}
	if _, err := h.svc.SetAdmin(ctx, owner, chatID, admin, true); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.LeaveChat(ctx, owner, chatID, 0); err != nil {
		t.Fatal(err)
	}
	if c, _, _ := h.svc.GetChat(ctx, admin, chatID); c.GetMyRole() != appv1.MemberRole_MEMBER_ROLE_OWNER {
		t.Fatalf("heir role = %v", c.GetMyRole())
	}
	// Groups follow the same rule; an owner alone may leave.
	member := h.user("member")
	g := h.group(owner, member)
	if _, err := h.svc.LeaveChat(ctx, owner, g, 0); codeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("group owner leaves without an admin: %v", err)
	}
	if _, err := h.svc.LeaveChat(ctx, member, g, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.LeaveChat(ctx, owner, g, 0); err != nil {
		t.Fatalf("owner alone leaves: %v", err)
	}
}

func TestBlockHidesPresenceTypingAndReactions(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a, b := h.user("a"), h.user("b")
	everyone := appv1.PrivacyAudience_PRIVACY_AUDIENCE_EVERYONE
	if _, err := h.svc.SetPrivacy(ctx, b, &appv1.SetPrivacyRequest{LastSeen: &everyone}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.st.Pool().Exec(ctx, `UPDATE users SET last_seen_at = now() WHERE id = $1`, b); err != nil {
		t.Fatal(err)
	}
	chat, _, err := h.svc.CreatePrivate(ctx, a, b)
	if err != nil {
		t.Fatal(err)
	}
	seq := h.send(b, chat.GetId(), "hi").GetMessage().GetSeq()
	if err := h.svc.Block(ctx, b, a); err != nil {
		t.Fatal(err)
	}
	if users, _ := h.svc.GetUsers(ctx, a, []int64{b}); len(users) != 1 || users[0].GetStatus().GetKind() != appv1.UserStatusKind_USER_STATUS_KIND_UNSPECIFIED {
		t.Fatalf("blocked user sees the blocker's status: %v", users)
	}
	if st, err := h.svc.UserStatus(ctx, a, b, true); err != nil || st.GetKind() != appv1.UserStatusKind_USER_STATUS_KIND_UNSPECIFIED {
		t.Fatalf("presence for the blocked user = %v, %v", st, err)
	}
	if _, err := h.svc.SetReaction(ctx, a, chat.GetId(), seq, "👍"); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("blocked user reacts: %v", err)
	}
	for user, want := range map[int64]ChatAccess{
		a: {ChatID: chat.GetId(), PeerID: b, CanSend: false, Blocked: true},
		b: {ChatID: chat.GetId(), PeerID: a, CanSend: true, Blocked: true},
	} {
		access, err := h.svc.MemberChats(ctx, user, []int64{chat.GetId()})
		if err != nil || len(access) != 1 || access[0] != want {
			t.Fatalf("access of %d = %v, %v; want %v", user, access, err, want)
		}
	}
	publisher := h.user("publisher")
	ch, err := h.svc.CreateChannel(ctx, publisher, "news", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.AddMembers(ctx, publisher, ch.GetChat().GetId(), []int64{b}); err != nil {
		t.Fatal(err)
	}
	if access, _ := h.svc.MemberChats(ctx, b, []int64{ch.GetChat().GetId()}); len(access) != 1 || access[0].CanSend {
		t.Fatalf("channel reader may type: %v", access)
	}
}

func TestRemoveWithoutBanAllowsRejoin(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner, member, removed, newcomer := h.user("owner"), h.user("member"), h.user("removed"), h.user("newcomer")
	chatID := h.group(owner, member, removed)
	ownerLink := inviteOf(t, h, owner, chatID)
	removedLink := inviteOf(t, h, removed, chatID)
	if _, err := h.svc.RemoveMember(ctx, owner, chatID, removed, false); err != nil {
		t.Fatal(err)
	}
	if b, _ := h.svc.GetBannedMembers(ctx, owner, chatID, "", 0); len(b.GetMembers()) != 0 {
		t.Fatalf("remove-only banned: %v", b)
	}
	// While its creator is out, their link admits nobody; it is not revoked.
	if _, err := h.svc.JoinByInvite(ctx, newcomer, removedLink); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("link of a removed creator: %v", err)
	}
	if _, err := h.svc.JoinByInvite(ctx, removed, ownerLink); err != nil {
		t.Fatalf("rejoin after remove-only: %v", err)
	}
	if _, err := h.svc.JoinByInvite(ctx, newcomer, removedLink); err != nil {
		t.Fatalf("link works again once its creator is back: %v", err)
	}
	links, err := h.svc.GetInviteLinks(ctx, owner, chatID)
	if err != nil {
		t.Fatal(err)
	}
	for _, l := range links {
		if l.GetRevoked() {
			t.Fatalf("remove-only revoked a link: %v", l)
		}
	}
}
