package chat

import (
	"context"
	"fmt"
	"slices"
	"sync"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/store"
	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
)

// rename sets the display name of a user (usernames cannot hold accents).
func (h *harness) rename(id int64, name string) {
	h.t.Helper()
	if _, err := h.st.Pool().Exec(context.Background(), `UPDATE users SET name = $2 WHERE id = $1`, id, name); err != nil {
		h.t.Fatal(err)
	}
}

// dm opens the private chat of two Chat accounts and returns its id.
func (h *harness) dm(a, b int64) int64 {
	h.t.Helper()
	chat, _, err := h.svc.CreatePrivate(context.Background(), a, b)
	if err != nil {
		h.t.Fatal(err)
	}
	return chat.GetId()
}

// bridgeAccount makes a bridge account of owner and returns its id.
func (h *harness) bridgeAccount(owner int64, ref string) int64 {
	h.t.Helper()
	var id int64
	if err := h.st.Pool().QueryRow(context.Background(), `
		INSERT INTO external_accounts (owner_id, source, external_ref, secret) VALUES ($1, 'telegram', $2, '\x00') RETURNING id`,
		owner, ref).Scan(&id); err != nil {
		h.t.Fatal(err)
	}
	return id
}

// puppetDM makes a puppet user of the bridge account, the private chat that
// owner has with it (the way the importer makes it), and returns both ids.
func (h *harness) puppetDM(owner, account int64, name string) (puppet, chatID int64) {
	h.t.Helper()
	ctx := context.Background()
	h.n++
	id, err := store.NextUserID(ctx, h.st.Pool())
	if err != nil {
		h.t.Fatal(err)
	}
	if _, err := h.st.Pool().Exec(ctx, `
		INSERT INTO users (id, tenant_id, idp_sub, username, name, external_source) VALUES ($1, $2, NULL, $3, $4, 'telegram')`,
		id, h.svc.cfg.TenantID, fmt.Sprintf("ext_%d", h.n), name); err != nil {
		h.t.Fatal(err)
	}
	if _, err := h.st.Pool().Exec(ctx, `INSERT INTO external_users (account_id, external_user_id, user_id) VALUES ($1, $2, $3)`,
		account, fmt.Sprintf("tg-%d", h.n), id); err != nil {
		h.t.Fatal(err)
	}
	chatID, err = h.svc.CreateImportedChat(ctx, owner, ImportedChat{Kind: "private", Peer: id}, func(pgx.Tx, int64) error { return nil })
	if err != nil {
		h.t.Fatal(err)
	}
	return id, chatID
}

func (h *harness) people(me int64) []*appv1.Person {
	h.t.Helper()
	people, err := h.svc.ListPeople(context.Background(), me)
	if err != nil {
		h.t.Fatal(err)
	}
	return people
}

func (h *harness) link(me int64, ids ...int64) *appv1.Person {
	h.t.Helper()
	p, err := h.svc.LinkUsers(context.Background(), me, &appv1.LinkUsersRequest{UserIds: ids})
	if err != nil {
		h.t.Fatalf("LinkUsers(%v): %v", ids, err)
	}
	return p
}

func sortedIDs(ids ...int64) []int64 {
	out := slices.Clone(ids)
	slices.Sort(out)
	return out
}

func memberIDs(p *appv1.Person) []int64 {
	var ids []int64
	for _, m := range p.GetMembers() {
		ids = append(ids, m.GetUserId())
	}
	slices.Sort(ids)
	return ids
}

func (h *harness) suggestions(me, userID int64) []*appv1.LinkSuggestion {
	h.t.Helper()
	out, err := h.svc.ListLinkSuggestions(context.Background(), me, userID)
	if err != nil {
		h.t.Fatal(err)
	}
	return out
}

// peopleChangedCount is how many people_changed hints the user's log holds.
func (h *harness) peopleChangedCount(userID int64) int {
	h.t.Helper()
	n := 0
	for _, u := range h.logOf(userID) {
		if u.GetPeopleChanged() != nil {
			n++
		}
	}
	return n
}

func (h *harness) messageCount(chatID int64) int {
	h.t.Helper()
	var n int
	if err := h.st.Pool().QueryRow(context.Background(), `SELECT count(*) FROM messages WHERE chat_id = $1`, chatID).Scan(&n); err != nil {
		h.t.Fatal(err)
	}
	return n
}

func TestLinkMakesOnePersonWithPinnedNameAndChats(t *testing.T) {
	h := newHarness(t, nil)
	owner, an := h.user("owner"), h.user("an_real")
	h.rename(an, "Trần Văn An")
	anChat := h.dm(owner, an)
	acct := h.bridgeAccount(owner, "tg-owner")
	tg, tgChat := h.puppetDM(owner, acct, "Tran van an")

	// The Chat account is named first by the pinned rule even when listed second.
	p := h.link(owner, tg, an)
	if p.GetName() != "Trần Văn An" {
		t.Fatalf("pinned name = %q, want the Chat account's", p.GetName())
	}
	if !slices.Equal(memberIDs(p), sortedIDs(an, tg)) {
		t.Fatalf("members = %v", memberIDs(p))
	}
	chats := map[int64]int64{}
	apps := map[int64]string{}
	for _, m := range p.GetMembers() {
		chats[m.GetUserId()], apps[m.GetUserId()] = m.GetChatId(), m.GetApp()
	}
	if chats[an] != anChat || chats[tg] != tgChat || apps[an] != "" || apps[tg] != "telegram" {
		t.Fatalf("member chats %v apps %v, want %d/%d and \"\"/telegram", chats, apps, anChat, tgChat)
	}

	// The name is pinned: renaming an identity later does not rename the person.
	h.rename(an, "Another Name")
	got := h.people(owner)
	if len(got) != 1 || got[0].GetName() != "Trần Văn An" {
		t.Fatalf("people after rename = %v", got)
	}
	for _, m := range got[0].GetMembers() {
		if m.GetUserId() == an && m.GetName() != "Another Name" {
			t.Fatalf("member name = %q, want the current one", m.GetName())
		}
	}
	if n := h.peopleChangedCount(owner); n != 1 {
		t.Fatalf("people_changed hints = %d, want 1", n)
	}
}

func TestLinkRejectsWhatItShould(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner, a, b := h.user("owner"), h.user("a_user"), h.user("b_user")
	h.dm(owner, a)
	h.dm(owner, b)
	stranger := h.user("stranger")
	one := func(ids ...int64) error {
		_, err := h.svc.LinkUsers(ctx, owner, &appv1.LinkUsersRequest{UserIds: ids})
		return err
	}
	for name, ids := range map[string][]int64{
		"one user": {a}, "the same user twice": {a, a}, "oneself": {a, owner}, "a zero id": {a, 0},
	} {
		if code := codeOf(one(ids...)); code != connect.CodeInvalidArgument {
			t.Errorf("%s: code %v, want InvalidArgument", name, code)
		}
	}
	many := make([]int64, 0, peopleLinkMax+1)
	for i := range peopleLinkMax + 1 {
		many = append(many, int64(1000+i))
	}
	if code := codeOf(one(many...)); code != connect.CodeInvalidArgument {
		t.Errorf("too many users: code %v", code)
	}

	// A user with no private chat with the caller looks exactly like one that does not exist.
	missing := one(a, stranger)
	unknown := one(a, 987654321)
	if codeOf(missing) != connect.CodeNotFound || codeOf(unknown) != connect.CodeNotFound || missing.Error() != unknown.Error() {
		t.Fatalf("stranger: %v, unknown: %v; want the same NotFound", missing, unknown)
	}
	if n := len(h.people(owner)); n != 0 {
		t.Fatalf("a refused link left %d people", n)
	}

	// A deleted copy of a chat no longer makes its peer a candidate.
	gone := h.user("gone_user")
	goneChat := h.dm(owner, gone)
	if _, err := h.st.Pool().Exec(ctx, `UPDATE chats SET deleted_at = now() WHERE id = $1`, goneChat); err != nil {
		t.Fatal(err)
	}
	if code := codeOf(one(a, gone)); code != connect.CodeNotFound {
		t.Fatalf("deleted chat peer: code %v, want NotFound", code)
	}
}

func TestAnotherUserCannotLinkOrReadMyUsers(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner, attacker, an := h.user("owner"), h.user("attacker"), h.user("an_real")
	acct := h.bridgeAccount(owner, "tg-owner")
	tg, _ := h.puppetDM(owner, acct, "An")
	h.dm(owner, an)
	h.link(owner, an, tg)

	// The attacker has chats of their own but names the owner's shadow user.
	mine := h.user("attacker_friend")
	h.dm(attacker, mine)
	_, err := h.svc.LinkUsers(ctx, attacker, &appv1.LinkUsersRequest{UserIds: []int64{mine, tg}})
	if codeOf(err) != connect.CodeNotFound {
		t.Fatalf("linking someone else's shadow user: %v", err)
	}
	if err := h.svc.RejectLinkSuggestion(ctx, attacker, mine, tg); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("rejecting with someone else's shadow user: %v", err)
	}
	if _, err := h.svc.ListLinkSuggestions(ctx, attacker, tg); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("suggestions for someone else's shadow user: %v", err)
	}
	if got := h.people(attacker); len(got) != 0 {
		t.Fatalf("the attacker sees people: %v", got)
	}
	// Unlinking only ever touches the caller's own rows.
	if err := h.svc.UnlinkUser(ctx, attacker, tg); err != nil {
		t.Fatal(err)
	}
	if got := h.people(owner); len(got) != 1 || len(got[0].GetMembers()) != 2 {
		t.Fatalf("the owner's person was changed by someone else: %v", got)
	}
	var rows int
	if err := h.st.Pool().QueryRow(ctx, `SELECT (SELECT count(*) FROM people WHERE owner_id = $1) + (SELECT count(*) FROM people_rejections WHERE owner_id = $1)`, attacker).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("the attacker owns %d rows (err %v)", rows, err)
	}
}

func TestLinkMergesPeopleIntoTheLowestIdAndAddsToOne(t *testing.T) {
	h := newHarness(t, nil)
	owner := h.user("owner")
	acct := h.bridgeAccount(owner, "tg-owner")
	var u [5]int64
	for i := range u {
		u[i], _ = h.puppetDM(owner, acct, fmt.Sprintf("Person %d", i))
	}
	first := h.link(owner, u[0], u[1])
	second := h.link(owner, u[2], u[3])
	if first.GetId() >= second.GetId() {
		t.Fatalf("ids %d, %d are not in creation order", first.GetId(), second.GetId())
	}
	// Adding a user to an existing person keeps the person.
	added := h.link(owner, u[1], u[4])
	if added.GetId() != first.GetId() || len(added.GetMembers()) != 3 {
		t.Fatalf("add: %v", added)
	}
	// Naming users of two people merges them into the one with the lowest id and keeps its name.
	merged := h.link(owner, u[0], u[2])
	if merged.GetId() != first.GetId() || len(merged.GetMembers()) != 5 || merged.GetName() != first.GetName() {
		t.Fatalf("merge: %v", merged)
	}
	if got := h.people(owner); len(got) != 1 {
		t.Fatalf("after merge there are %d people, want 1", len(got))
	}
	var n int
	if err := h.st.Pool().QueryRow(context.Background(), `SELECT count(*) FROM people_members WHERE owner_id = $1`, owner).Scan(&n); err != nil || n != 5 {
		t.Fatalf("member rows = %d (err %v), want 5: a user is in one person", n, err)
	}
}

func TestUnlinkRemovesAPersonLeftAloneAndNeverTouchesMessages(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner, friend := h.user("owner"), h.user("friend")
	friendChat := h.dm(owner, friend)
	acct := h.bridgeAccount(owner, "tg-owner")
	b, _ := h.puppetDM(owner, acct, "B")
	c, _ := h.puppetDM(owner, acct, "C")
	h.send(owner, friendChat, "hello")
	before := h.messageCount(friendChat)
	h.link(owner, friend, b, c)
	hints := h.peopleChangedCount(owner)

	if err := h.svc.UnlinkUser(ctx, owner, c); err != nil {
		t.Fatal(err)
	}
	if got := h.people(owner); len(got) != 1 || !slices.Equal(memberIDs(got[0]), sortedIDs(friend, b)) {
		t.Fatalf("after one unlink: %v", got)
	}
	if err := h.svc.UnlinkUser(ctx, owner, b); err != nil {
		t.Fatal(err)
	}
	if got := h.people(owner); len(got) != 0 {
		t.Fatalf("a person left with one user stays: %v", got)
	}
	// Unlinking a user that is in no person is a quiet no-op: no hint is sent.
	hintsBefore := h.peopleChangedCount(owner)
	if err := h.svc.UnlinkUser(ctx, owner, friend); err != nil {
		t.Fatal(err)
	}
	if now := h.peopleChangedCount(owner); now != hintsBefore || hintsBefore != hints+2 {
		t.Fatalf("hints %d then %d, started at %d", hintsBefore, now, hints)
	}
	if after := h.messageCount(friendChat); after != before {
		t.Fatalf("messages %d -> %d: linking and unlinking must not change them", before, after)
	}
	var left int
	if err := h.st.Pool().QueryRow(ctx, `SELECT count(*) FROM people_members WHERE owner_id = $1`, owner).Scan(&left); err != nil || left != 0 {
		t.Fatalf("member rows left = %d (err %v)", left, err)
	}
}

func TestSuggestionsByFoldedNameWithRejectionsAndFilters(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	an := h.user("an_real")
	h.rename(an, "Trần Văn An")
	h.dm(owner, an)
	other := h.user("other_real")
	h.rename(other, "TRAN VAN AN")
	h.dm(owner, other)
	acct, acct2 := h.bridgeAccount(owner, "tg-1"), h.bridgeAccount(owner, "tg-2")
	tg, _ := h.puppetDM(owner, acct, "tran  van an")
	tg2, _ := h.puppetDM(owner, acct, "Trần Văn An")
	zalo, _ := h.puppetDM(owner, acct2, "Trần văn An")
	loner, _ := h.puppetDM(owner, acct, "Someone Else")

	pairs := map[[2]int64]bool{}
	for _, s := range h.suggestions(owner, 0) {
		if s.GetReason() != appv1.LinkSuggestionReason_LINK_SUGGESTION_REASON_NAME {
			t.Fatalf("reason = %v", s.GetReason())
		}
		pairs[[2]int64{s.GetFirst().GetUserId(), s.GetSecond().GetUserId()}] = true
	}
	// Equal after folding case, accents and spaces; never two Chat accounts or two puppets of one account.
	want := [][2]int64{{an, tg}, {an, tg2}, {an, zalo}, {other, tg}, {other, tg2}, {other, zalo}, {tg, zalo}, {tg2, zalo}}
	for _, p := range want {
		if !pairs[[2]int64{min(p[0], p[1]), max(p[0], p[1])}] {
			t.Errorf("missing suggestion %v", p)
		}
	}
	if len(pairs) != len(want) {
		t.Fatalf("got %d suggestions, want %d: %v", len(pairs), len(want), pairs)
	}
	for _, p := range [][2]int64{{an, other}, {tg, tg2}} {
		if pairs[[2]int64{min(p[0], p[1]), max(p[0], p[1])}] {
			t.Errorf("suggested %v", p)
		}
	}
	for p := range pairs {
		if p[0] == loner || p[1] == loner {
			t.Errorf("a different name was suggested: %v", p)
		}
	}

	// For one user only the pairs that involve them.
	for _, s := range h.suggestions(owner, zalo) {
		if s.GetFirst().GetUserId() != zalo && s.GetSecond().GetUserId() != zalo {
			t.Errorf("suggestion without the user: %v", s)
		}
	}
	if _, err := h.svc.ListLinkSuggestions(ctx, owner, h.user("stranger")); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("suggestions for a stranger: %v", err)
	}

	// Rejecting hides a pair, in either order, and tells the other sessions.
	hints := h.peopleChangedCount(owner)
	if err := h.svc.RejectLinkSuggestion(ctx, owner, zalo, an); err != nil {
		t.Fatal(err)
	}
	if err := h.svc.RejectLinkSuggestion(ctx, owner, an, zalo); err != nil {
		t.Fatal(err)
	}
	if h.peopleChangedCount(owner) != hints+1 {
		t.Fatalf("rejecting twice announced %d times, want once", h.peopleChangedCount(owner)-hints)
	}
	for _, s := range h.suggestions(owner, 0) {
		if p := ([2]int64{s.GetFirst().GetUserId(), s.GetSecond().GetUserId()}); p == [2]int64{min(an, zalo), max(an, zalo)} {
			t.Fatalf("a rejected pair came back: %v", p)
		}
	}
	// A pair inside one person is not suggested, and linking it clears an older rejection.
	h.link(owner, an, tg)
	h.link(owner, an, zalo)
	for _, s := range h.suggestions(owner, 0) {
		a, b := s.GetFirst().GetUserId(), s.GetSecond().GetUserId()
		if (a == an || a == tg || a == zalo) && (b == an || b == tg || b == zalo) {
			t.Fatalf("a pair inside one person was suggested: %d %d", a, b)
		}
	}
	var rejections int
	if err := h.st.Pool().QueryRow(ctx, `SELECT count(*) FROM people_rejections WHERE owner_id = $1`, owner).Scan(&rejections); err != nil || rejections != 0 {
		t.Fatalf("rejections inside a person stay: %d (err %v)", rejections, err)
	}
}

func TestConcurrentLinksEndInOnePerson(t *testing.T) {
	h := newHarness(t, nil)
	owner := h.user("owner")
	acct := h.bridgeAccount(owner, "tg-owner")
	var u [4]int64
	for i := range u {
		u[i], _ = h.puppetDM(owner, acct, fmt.Sprintf("P%d", i))
	}
	sets := [][]int64{{u[0], u[1]}, {u[1], u[2]}, {u[2], u[3]}, {u[0], u[3]}}
	var wg sync.WaitGroup
	errs := make(chan error, len(sets))
	for _, ids := range sets {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := h.svc.LinkUsers(context.Background(), owner, &appv1.LinkUsersRequest{UserIds: ids})
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	got := h.people(owner)
	if len(got) != 1 || !slices.Equal(memberIDs(got[0]), sortedIDs(u[:]...)) {
		t.Fatalf("concurrent links gave %d people: %v", len(got), got)
	}
}

func TestPeopleAreScopedToTheirOwner(t *testing.T) {
	h := newHarness(t, nil)
	one, two, shared := h.user("owner_one"), h.user("owner_two"), h.user("shared_friend")
	h.dm(one, shared)
	h.dm(two, shared)
	acct1, acct2 := h.bridgeAccount(one, "tg-1"), h.bridgeAccount(two, "tg-2")
	p1, _ := h.puppetDM(one, acct1, "Shared")
	p2, _ := h.puppetDM(two, acct2, "Shared")
	h.link(one, shared, p1)
	if got := h.people(two); len(got) != 0 {
		t.Fatalf("the other owner sees %v", got)
	}
	// The same user can be in a person of each owner.
	h.link(two, shared, p2)
	if len(h.people(one)) != 1 || len(h.people(two)) != 1 {
		t.Fatalf("one: %v, two: %v", h.people(one), h.people(two))
	}
}

func TestDetachBridgeAccountDropsPuppetsAndLonelyPeople(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner, an := h.user("owner"), h.user("an_real")
	h.dm(owner, an)
	removed, kept := h.bridgeAccount(owner, "tg-removed"), h.bridgeAccount(owner, "tg-kept")
	tg, _ := h.puppetDM(owner, removed, "An")
	tg2, _ := h.puppetDM(owner, removed, "Cuong")
	third, _ := h.puppetDM(owner, removed, "Dung")
	other1, _ := h.puppetDM(owner, kept, "Binh")
	other2, _ := h.puppetDM(owner, kept, "Binh again")
	h.link(owner, an, tg)                                                     // loses its puppet and is left with one user: goes
	h.link(owner, other1, other2, tg2)                                        // loses its puppet and keeps two users: stays
	if err := h.svc.RejectLinkSuggestion(ctx, owner, an, third); err != nil { // names a puppet of the removed account: goes
		t.Fatal(err)
	}
	if err := h.svc.RejectLinkSuggestion(ctx, owner, an, other1); err != nil { // names only kept users: stays
		t.Fatal(err)
	}
	if err := pgx.BeginFunc(ctx, h.st.Pool(), func(tx pgx.Tx) error {
		return h.svc.DetachBridgeAccount(ctx, tx, owner, removed)
	}); err != nil {
		t.Fatal(err)
	}
	got := h.people(owner)
	if len(got) != 1 || !slices.Equal(memberIDs(got[0]), sortedIDs(other1, other2)) {
		t.Fatalf("people after detach = %v", got)
	}
	var rejections int
	if err := h.st.Pool().QueryRow(ctx, `SELECT count(*) FROM people_rejections WHERE owner_id = $1`, owner).Scan(&rejections); err != nil || rejections != 1 {
		t.Fatalf("rejections after detach = %d (err %v), want the one between kept users", rejections, err)
	}
}
