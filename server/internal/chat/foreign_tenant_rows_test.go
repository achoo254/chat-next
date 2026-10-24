package chat

import (
	"context"
	"errors"
	"slices"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/store"
	"connectrpc.com/connect"
)

// Every row keeps its tenant_id and every query filters on the service's
// own tenant. Nothing in the service writes another tenant_id any more, so
// such rows only come from raw SQL (old data, a manual fix); they must never
// be read back through the service or the store.
func TestRowsOfAnotherTenantAreNeverRead(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	pool := h.st.Pool()
	if err := h.st.EnsureTenant(ctx, "other", "other.test", "other.test"); err != nil {
		t.Fatal(err)
	}
	me, peer := h.user("me"), h.user("peer")
	// GetUsers returns only people the caller shares a chat with.
	own := h.group(me, peer)

	// A user of another tenant, inserted by raw SQL, findable by everyone
	// and addable to groups, so only the tenant filter can hide it.
	const stranger = int64(1)<<52 + 777
	if _, err := pool.Exec(ctx, `
		INSERT INTO users (id, tenant_id, idp_sub, username, name, email, email_verified)
		VALUES ($1, 'other', 'acc_stranger', 'stranger', 'Stranger', 'stranger@other.test', true)`, stranger); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO privacy_settings (user_id, add_to_groups, find_by_email) VALUES ($1, 1, $2)`,
		stranger, audEveryone); err != nil {
		t.Fatal(err)
	}

	if _, err := h.st.UserByID(ctx, testTenant, stranger); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("store UserByID: %v", err)
	}
	if _, err := h.svc.ResolveUsername(ctx, me, "stranger"); codeOf(err) != connect.CodeNotFound {
		t.Errorf("ResolveUsername: %v", err)
	}
	if _, err := h.svc.AddContact(ctx, me, &appv1.AddContactRequest{Target: &appv1.AddContactRequest_UserId{UserId: stranger}}); codeOf(err) != connect.CodeNotFound {
		t.Errorf("AddContact by id: %v", err)
	}
	if _, err := h.svc.AddContact(ctx, me, &appv1.AddContactRequest{Target: &appv1.AddContactRequest_Email{Email: "stranger@other.test"}}); codeOf(err) != connect.CodeNotFound {
		t.Errorf("AddContact by email: %v", err)
	}
	if users, err := h.svc.GetUsers(ctx, me, []int64{stranger, peer}); err != nil || len(users) != 1 || users[0].GetId() != peer {
		t.Errorf("GetUsers = %v, %v", users, err)
	}
	for _, q := range []string{"stranger", "stranger@other.test"} {
		if found, err := h.svc.SearchUsers(ctx, me, q, 10); err != nil || len(found) != 0 {
			t.Errorf("SearchUsers(%q) = %v, %v", q, found, err)
		}
	}
	if _, _, err := h.svc.CreatePrivate(ctx, me, stranger); codeOf(err) != connect.CodeNotFound {
		t.Errorf("CreatePrivate: %v", err)
	}
	resp, err := h.svc.AddMembers(ctx, me, own, []int64{stranger})
	if err != nil || !slices.Equal(resp.GetFailedUserIds(), []int64{stranger}) ||
		resp.GetFailures()[0].GetReason() != appv1.AddMemberFailureReason_ADD_MEMBER_FAILURE_REASON_NOT_FOUND {
		t.Errorf("AddMembers = %v, %v", resp, err)
	}

	// A chat moved to another tenant by raw SQL disappears for its own
	// members: reads, history, search and the dialog list.
	foreign := h.group(me, peer)
	h.send(me, foreign, "ke hoach bi mat")
	if got := h.found(me, "ke hoach"); len(got) != 1 {
		t.Fatalf("own chat not searched before the move: %q", got)
	}
	if _, err := pool.Exec(ctx, `UPDATE chats SET tenant_id = 'other' WHERE id = $1`, foreign); err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.svc.GetChat(ctx, me, foreign); codeOf(err) != connect.CodeNotFound {
		t.Errorf("GetChat: %v", err)
	}
	if _, err := h.svc.GetHistory(ctx, me, &appv1.GetHistoryRequest{ChatId: foreign, Limit: 10}); codeOf(err) != connect.CodeNotFound {
		t.Errorf("GetHistory: %v", err)
	}
	if _, err := h.svc.SendMessage(ctx, me, &appv1.SendMessageRequest{ChatId: foreign, Text: "hi"}); codeOf(err) != connect.CodeNotFound {
		t.Errorf("SendMessage: %v", err)
	}
	if got := h.found(me, "ke hoach"); len(got) != 0 {
		t.Errorf("SearchMessages found %q", got)
	}
	dialogs, err := h.svc.GetDialogs(ctx, me, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range dialogs.GetDialogs() {
		if d.GetChatId() == foreign {
			t.Error("the chat of another tenant is in the dialog list")
		}
	}

	// An outbox row of another tenant is never consumed.
	var otherRow int64
	if err := pool.QueryRow(ctx, `INSERT INTO outbox (kind, tenant_id) VALUES ('read', 'other') RETURNING id`).Scan(&otherRow); err != nil {
		t.Fatal(err)
	}
	rows, err := h.svc.ReadOutbox(ctx, 0, 10000)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range rows {
		if r.ID == otherRow {
			t.Fatal("ReadOutbox returned a row of another tenant")
		}
	}
}
