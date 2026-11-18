package chat

import (
	"context"
	"testing"
)

func (h *harness) externalPuppet(owner, chatID int64, name string) int64 {
	h.t.Helper()
	ctx := context.Background()
	id := h.puppet(chatID, name)
	if _, err := h.st.Pool().Exec(ctx, `
		INSERT INTO external_users (account_id, external_user_id, user_id)
		SELECT a.id, $2, $3 FROM external_accounts a WHERE a.owner_id = $1 LIMIT 1
		ON CONFLICT DO NOTHING`, owner, name, id); err != nil {
		h.t.Fatal(err)
	}
	return id
}

func TestSyncMembersFollowsThePuppetsAndNeverTouchesTheOwnerOrChatOnlyMembers(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	chatOnly := h.user("chatonly")
	chatID := h.group(owner, chatOnly)
	h.linkChat(owner, chatID, DirectionIn)
	an := h.externalPuppet(owner, chatID, "an")
	binh := h.externalPuppet(owner, chatID, "binh")
	sync := func(complete bool, members ...ImportedMember) bool {
		var changed bool
		if err := h.importInto(chatID, owner, func(it *ImportTx) error {
			var err error
			changed, err = it.SyncMembers(ctx, members, complete)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		return changed
	}
	role := func(user int64) string {
		var r *string
		if err := h.st.Pool().QueryRow(ctx, `SELECT CASE WHEN left_at IS NULL THEN role END FROM chat_members WHERE chat_id = $1 AND user_id = $2`, chatID, user).Scan(&r); err != nil {
			return "none"
		}
		if r == nil {
			return "left"
		}
		return *r
	}
	if !sync(true, ImportedMember{an, false}, ImportedMember{binh, true}, ImportedMember{owner, true}) {
		t.Fatal("two people joined and nothing changed")
	}
	if role(an) != "member" || role(binh) != "admin" || role(owner) != "owner" {
		t.Fatalf("roles = an %s, binh %s, owner %s", role(an), role(binh), role(owner))
	}
	if sync(true, ImportedMember{an, false}, ImportedMember{binh, true}) {
		t.Fatal("the same members again reported a change")
	}
	// Bình leaves and An becomes admin; a list that is not the whole group removes nobody
	sync(false, ImportedMember{an, true})
	if role(binh) != "admin" || role(an) != "admin" {
		t.Fatalf("a partial list: binh %s, an %s", role(binh), role(an))
	}
	sync(true, ImportedMember{an, true})
	if role(binh) != "left" {
		t.Fatalf("Bình = %s after the full list without them", role(binh))
	}
	if role(chatOnly) != "member" || role(owner) != "owner" {
		t.Fatalf("chat-only %s, owner %s: the other app's list must not touch them", role(chatOnly), role(owner))
	}
	// and Bình can join again
	sync(true, ImportedMember{an, true}, ImportedMember{binh, false})
	if role(binh) != "member" {
		t.Fatalf("Bình after rejoining = %s", role(binh))
	}
	var count int
	if err := h.st.Pool().QueryRow(ctx, `SELECT member_count FROM chats WHERE id = $1`, chatID).Scan(&count); err != nil || count != 4 {
		t.Fatalf("member_count = %d (%v), want owner + chat-only + two people = 4", count, err)
	}
}
