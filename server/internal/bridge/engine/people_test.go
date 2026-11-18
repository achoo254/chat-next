package engine_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/engine"
	"app.local/server/internal/bridge/feature"
	"app.local/server/internal/store"
)

// peopleChat is a two-way chat g1 of the fake with the feature switched to send.
func (e *env) peopleChat(feat feature.Feature, dir feature.Direction) (*engine.Engine, int64) {
	e.t.Helper()
	conv := e.group("g1")
	e.fake.AddHistory("g1", e.msg("m1", lan, "tin 1", 1))
	eng, chatID := e.enableWith(conv)
	e.waitTexts(chatID, []string{"tin 1"})
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	if err := eng.SetFeature(context.Background(), e.owner, e.account, "g1", feat, dir); err != nil {
		e.t.Fatal(err)
	}
	return eng, chatID
}

func (e *env) chatTitle(chatID int64) string {
	var t string
	if err := e.st.Pool().QueryRow(context.Background(), `SELECT title FROM chats WHERE id = $1`, chatID).Scan(&t); err != nil {
		e.t.Fatal(err)
	}
	return t
}

func TestInviteLinksOfTheOtherAppAreListedMadeAndRevokedFromChatOnlyWhenTheFeatureSends(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	conv := e.group("g1")
	e.fake.AddHistory("g1", e.msg("m1", lan, "tin 1", 1))
	e.fake.SetInvites("g1", bridge.InviteLink{Link: "https://fake.test/+old", Title: "cũ", Usage: 3})
	eng, chatID := e.enableWith(conv)
	e.waitTexts(chatID, []string{"tin 1"})
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	if err := eng.CreateInvite(ctx, e.owner, e.account, "g1", "mới"); !errors.Is(err, engine.ErrFeatureOff) {
		t.Fatalf("making a link with the invites feature off = %v, want ErrFeatureOff", err)
	}
	if err := eng.SetFeature(ctx, e.owner, e.account, "g1", feature.Invites, feature.Both); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool {
		l, _ := eng.Invites(ctx, e.owner, e.account, "g1")
		return len(l) == 1 && l[0].Usage == 3
	}, func() string { return "the link of the other app was not listed" })
	if err := eng.CreateInvite(ctx, e.owner, e.account, "g1", "mới"); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool { l, _ := eng.Invites(ctx, e.owner, e.account, "g1"); return len(l) == 2 }, func() string { return "the new link did not appear" })
	if got := e.fake.Invites("g1"); len(got) != 2 || got[1].Title != "mới" {
		t.Fatalf("the other app has %+v", got)
	}
	if err := eng.RevokeInvite(ctx, e.owner, e.account, "g1", "https://fake.test/+old"); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool {
		for _, l := range e.fake.Invites("g1") {
			if l.Link == "https://fake.test/+old" && l.Revoked {
				return true
			}
		}
		return false
	}, func() string { return "the link was not revoked" })
	e.eventually(func() bool { return e.auditRows("sent") == 2 }, func() string {
		return fmt.Sprintf("%d audit rows sent, want 2 (made and revoked)", e.auditRows("sent"))
	})
}

func TestAPersonTheOtherAppHasShownCanBeAddedAndRestrictedFromChat(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	conv := e.group("g1")
	e.fake.AddHistory("g1", e.msg("m1", lan, "tin 1", 1), e.msg("m2", bridge.Participant{ID: "77", Name: "Dũng"}, "tin 2", 2))
	e.fake.SetMembers("g1", false)
	eng, chatID := e.enableWith(conv)
	e.waitTexts(chatID, []string{"tin 1", "tin 2"})
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	if err := eng.SetFeature(ctx, e.owner, e.account, "g1", feature.Members, feature.Both); err != nil {
		t.Fatal(err)
	}
	// Dũng wrote in the chat, so he is already a member; Giang is a person of the account who is not.
	giang, err := e.st.UpsertIdPUser(ctx, "primary", store.IdPProfile{Sub: "acc_giang", PreferredUsername: "giang", Name: "Giang"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.st.Pool().Exec(ctx, `INSERT INTO external_users (account_id, external_user_id, user_id) VALUES ($1, '88', $2)`, e.account, giang.ID); err != nil {
		t.Fatal(err)
	}
	cands, err := eng.Candidates(ctx, e.owner, e.account, "g1")
	if err != nil || len(cands) != 1 || cands[0].ParticipantID != "88" || cands[0].Name != "Giang" {
		t.Fatalf("candidates = %+v, %v, want only Giang (88): the people already in the chat are not offered", cands, err)
	}
	if err := eng.AddMember(ctx, e.owner, e.account, "g1", "999"); !errors.Is(err, engine.ErrNotFound) {
		t.Fatalf("adding a person nobody has shown = %v, want ErrNotFound", err)
	}
	if err := eng.AddMember(ctx, e.owner, e.account, "g1", "88"); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool { return len(e.fake.Members("g1")) == 1 }, func() string { return "the person was not added" })
	e.waitMembers(chatID, "Người 88:member")
	// restricted from Chat: no media, no pins
	dungID := e.memberUser(chatID, "Người 88")
	perms := uint32(appv1.ChatPermission_CHAT_PERMISSION_SEND_MESSAGES)
	if _, err := e.chat.SetMemberPermissions(ctx, e.owner, chatID, dungID, perms); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool { return len(e.fake.MemberCalls()) == 2 }, func() string { return fmt.Sprint(e.fake.MemberCalls()) })
	if got := e.fake.Members("g1")[0].Perms; got == nil || !got.Send || got.Media || got.Pin {
		t.Fatalf("the other app has the restriction %+v, want send only", got)
	}
}

func TestARestrictionInTheOtherAppReachesThePermissionsOfTheMemberInChat(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	conv := e.group("g1")
	e.fake.AddHistory("g1", e.msg("m1", lan, "tin 1", 1))
	e.fake.SetMembers("g1", false, bridge.Member{Participant: bridge.Participant{ID: "11", Name: "An"}, Perms: &bridge.Perms{Send: true}})
	eng, chatID := e.enableWith(conv)
	e.waitTexts(chatID, []string{"tin 1"})
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	if err := eng.SetFeature(ctx, e.owner, e.account, "g1", feature.Members, feature.In); err != nil {
		t.Fatal(err)
	}
	e.waitMembers(chatID, "An:member")
	var perms *int32
	e.eventually(func() bool {
		if err := e.st.Pool().QueryRow(ctx, `SELECT permissions FROM chat_members WHERE chat_id = $1 AND user_id = $2`, chatID, e.memberUser(chatID, "An")).Scan(&perms); err != nil {
			return false
		}
		return perms != nil && uint32(*perms) == uint32(appv1.ChatPermission_CHAT_PERMISSION_SEND_MESSAGES)
	}, func() string { return fmt.Sprint(perms) })
	// lifted in the other app: the restriction goes
	e.fake.SetMembers("g1", false, bridge.Member{Participant: bridge.Participant{ID: "11", Name: "An"}})
	e.eventually(func() bool {
		if err := e.st.Pool().QueryRow(ctx, `SELECT permissions FROM chat_members WHERE chat_id = $1 AND user_id = $2`, chatID, e.memberUser(chatID, "An")).Scan(&perms); err != nil {
			return false
		}
		return perms == nil
	}, func() string { return "the restriction stayed" })
}

func TestLeavingAGroupNeedsTheNameTheFeatureAndLeavesAReadOnlyCopy(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	eng, chatID := e.peopleChat(feature.Lifecycle, feature.Out)
	name := e.chatTitle(chatID)
	if err := eng.LeaveGroup(ctx, e.owner, e.account, "g1", "sai tên"); !errors.Is(err, engine.ErrConfirmation) {
		t.Fatalf("leaving with the wrong name = %v, want ErrConfirmation", err)
	}
	if n := len(e.fake.LifecycleCalls()); n != 0 {
		t.Fatalf("%d calls went out for a wrong name", n)
	}
	if err := eng.LeaveGroup(ctx, e.owner, e.account, "g1", "  "+name+" "); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool { return len(e.fake.LifecycleCalls()) == 1 }, func() string { return "the group was not left" })
	if got := e.fake.LifecycleCalls()[0]; got != "leave:g1" {
		t.Fatalf("call = %s", got)
	}
	var direction string
	e.eventually(func() bool {
		if err := e.st.Pool().QueryRow(ctx, `SELECT direction FROM external_chats WHERE chat_id = $1`, chatID).Scan(&direction); err != nil {
			return false
		}
		return direction == "in"
	}, func() string { return "the copy is not read-only: " + direction })
	// with the feature off it is refused before anything is queued
	if err := eng.SetFeature(ctx, e.owner, e.account, "g1", feature.Lifecycle, feature.Off); err != nil {
		t.Fatal(err)
	}
	if err := eng.LeaveGroup(ctx, e.owner, e.account, "g1", name); !errors.Is(err, engine.ErrFeatureOff) {
		t.Fatalf("leaving with the feature off = %v, want ErrFeatureOff", err)
	}
}

func TestDeletingAGroupNeedsTheNameAndASecondConfirmationAfterAWaitAndIsLogged(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	eng, chatID := e.peopleChat(feature.Lifecycle, feature.Out)
	name := e.chatTitle(chatID)
	if _, _, _, err := eng.RequestGroupDelete(ctx, e.owner, e.account, "g1", "sai tên"); !errors.Is(err, engine.ErrConfirmation) {
		t.Fatalf("requesting with the wrong name = %v", err)
	}
	token, from, until, err := eng.RequestGroupDelete(ctx, e.owner, e.account, "g1", name)
	if err != nil || token == "" || !until.After(from) {
		t.Fatalf("token = %q, %v..%v, %v", token, from, until, err)
	}
	// at once is too early: it must never be the answer to the click that asked
	if err := eng.DeleteGroup(ctx, e.owner, e.account, "g1", name, token); !errors.Is(err, engine.ErrConfirmation) {
		t.Fatalf("using the token at once = %v, want ErrConfirmation", err)
	}
	time.Sleep(time.Until(from) + 300*time.Millisecond)
	if err := eng.DeleteGroup(ctx, e.owner, e.account, "g1", "sai tên", token); !errors.Is(err, engine.ErrConfirmation) {
		t.Fatalf("a wrong name with a good token = %v", err)
	}
	if err := eng.DeleteGroup(ctx, e.owner, e.account, "g1", name, "token-bậy"); !errors.Is(err, engine.ErrConfirmation) {
		t.Fatalf("a made-up token = %v", err)
	}
	if n := len(e.fake.LifecycleCalls()); n != 0 {
		t.Fatalf("%d calls went out before a valid confirmation", n)
	}
	if err := eng.DeleteGroup(ctx, e.owner, e.account, "g1", name, token); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool { return len(e.fake.LifecycleCalls()) == 1 }, func() string { return "the group was not deleted" })
	if got := e.fake.LifecycleCalls()[0]; got != "delete:g1" {
		t.Fatalf("call = %s", got)
	}
	// logged before it was sent, and again with the outcome
	var started, sent int
	if err := e.st.Pool().QueryRow(ctx, `SELECT count(*) FILTER (WHERE result = 'started'), count(*) FILTER (WHERE result = 'sent') FROM external_audit WHERE action = 'group_delete'`).Scan(&started, &sent); err != nil || started != 1 || sent != 1 {
		t.Fatalf("audit: started %d, sent %d (%v)", started, sent, err)
	}
	// a token is good once
	if err := eng.DeleteGroup(ctx, e.owner, e.account, "g1", name, token); err == nil {
		t.Fatal("a token was used twice")
	}
}
