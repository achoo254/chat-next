package engine_test

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/feature"
	"app.local/server/internal/store"
)

func tgMember(id, name string, admin bool) bridge.Member {
	return bridge.Member{Participant: bridge.Participant{ID: id, Name: name}, Admin: admin}
}

// memberRoles is "name:role" of every active member of the chat that is not the owner, by name.
func (e *env) memberRoles(chatID int64) []string {
	e.t.Helper()
	rows, err := e.st.Pool().Query(context.Background(), `
		SELECT u.name || ':' || m.role FROM chat_members m JOIN users u ON u.id = m.user_id
		WHERE m.chat_id = $1 AND m.left_at IS NULL AND m.user_id <> $2 ORDER BY u.name`, chatID, e.owner)
	if err != nil {
		e.t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			e.t.Fatal(err)
		}
		out = append(out, s)
	}
	return out
}

func (e *env) waitMembers(chatID int64, want ...string) {
	e.t.Helper()
	e.eventually(func() bool { return fmt.Sprint(e.memberRoles(chatID)) == fmt.Sprint(want) },
		func() string { return fmt.Sprintf("members = %v, want %v", e.memberRoles(chatID), want) })
}

func (e *env) memberUser(chatID int64, name string) int64 {
	e.t.Helper()
	var id int64
	if err := e.st.Pool().QueryRow(context.Background(), `SELECT u.id FROM chat_members m JOIN users u ON u.id = m.user_id WHERE m.chat_id = $1 AND u.name = $2`, chatID, name).Scan(&id); err != nil {
		e.t.Fatal(err)
	}
	return id
}

func (e *env) auditRows(result string) int {
	var n int
	if err := e.st.Pool().QueryRow(context.Background(), `SELECT count(*) FROM external_audit WHERE feature = 'members' AND result = $1`, result).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

// membersOn turns the members feature on for g1 with the given direction.
func (e *env) membersOn(eng interface {
	SetFeature(context.Context, int64, int64, string, feature.Feature, feature.Direction) error
}, dir feature.Direction) {
	e.t.Helper()
	if err := eng.SetFeature(context.Background(), e.owner, e.account, "g1", feature.Members, dir); err != nil {
		e.t.Fatal(err)
	}
}

func TestMembersAreNotSyncedUntilTheFeatureIsTurnedOn(t *testing.T) {
	e := newEnv(t)
	conv := e.group("g1")
	e.fake.AddHistory("g1", e.msg("m1", lan, "tin 1", 1))
	e.fake.SetMembers("g1", false, tgMember("user:11", "An", false))
	eng, chatID := e.enableWith(conv)
	e.waitTexts(chatID, []string{"tin 1"})
	time.Sleep(400 * time.Millisecond)
	for _, r := range e.memberRoles(chatID) {
		if strings.HasPrefix(r, "An:") {
			t.Fatal("a member came in with the members feature off (its default)")
		}
	}
	e.membersOn(eng, feature.In)
	e.waitMembers(chatID, "An:member")
}

func TestPeopleWhoJoinLeaveAndBecomeAdminsInTheOtherAppFollowInChatAndChatOnlyMembersStay(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	conv := e.group("g1")
	e.fake.AddHistory("g1", e.msg("m1", lan, "tin 1", 1))
	e.fake.SetMembers("g1", false, tgMember("user:11", "An", false), tgMember("user:12", "Bình", true))
	eng, chatID := e.enableWith(conv)
	e.waitTexts(chatID, []string{"tin 1"})
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	// a member of Chat only, who has no account in the other app
	chatOnly := e.chatOnlyMember(chatID)
	e.membersOn(eng, feature.In)
	e.waitMembers(chatID, "An:member", "Bình:admin", "Chỉ ở Chat:member")
	e.fake.SetMembers("g1", false, tgMember("user:12", "Bình", false), tgMember("user:13", "Cường", true))
	e.waitMembers(chatID, "Bình:member", "Chỉ ở Chat:member", "Cường:admin")
	_ = chatOnly
	_ = ctx
	// a group too big to list in full: people are added, never removed
	e.fake.SetMembers("g1", true, tgMember("user:13", "Cường", true))
	time.Sleep(400 * time.Millisecond)
	if got := e.memberRoles(chatID); !strings.Contains(fmt.Sprint(got), "Bình:member") {
		t.Fatalf("a partial list removed somebody: %v", got)
	}
}

func TestRemovingOrPromotingAPersonOfTheOtherAppInChatActsThereOnlyWhenTheFeatureSendsAndIsLogged(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	conv := e.group("g1")
	e.fake.AddHistory("g1", e.msg("m1", lan, "tin 1", 1))
	e.fake.SetMembers("g1", false, tgMember("user:11", "An", false), tgMember("user:12", "Bình", false))
	eng, chatID := e.enableWith(conv)
	e.waitTexts(chatID, []string{"tin 1"})
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	if err := e.chat.SetImportedDirection(ctx, e.owner, chatID, "both"); err != nil {
		t.Fatal(err)
	}
	e.membersOn(eng, feature.In) // receives, does not send
	e.waitMembers(chatID, "An:member", "Bình:member")
	an := e.memberUser(chatID, "An")
	if _, err := e.chat.SetAdmin(ctx, e.owner, chatID, an, true); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	if n := len(e.fake.MemberCalls()); n != 0 {
		t.Fatalf("%d actions on people were sent with the members feature only receiving", n)
	}
	// turned on both ways: now the owner's removal of Bình is sent, and logged
	e.membersOn(eng, feature.Both)
	binh := e.memberUser(chatID, "Bình")
	if _, err := e.chat.RemoveMember(ctx, e.owner, chatID, binh, false); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool { return len(e.fake.MemberCalls()) == 1 }, func() string { return fmt.Sprint(e.fake.MemberCalls()) })
	if got := e.fake.MemberCalls()[0]; got != "remove:g1:user:12" {
		t.Fatalf("call = %s", got)
	}
	e.eventually(func() bool { return e.auditRows("sent") == 1 }, func() string { return "no audit row" })
	// a member who is Chat's own is never sent anywhere
	chatOnly := e.chatOnlyMember(chatID)
	if _, err := e.chat.RemoveMember(ctx, e.owner, chatID, chatOnly, false); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	if n := len(e.fake.MemberCalls()); n != 1 {
		t.Fatalf("removing a Chat-only member sent %d calls in all", n)
	}
}

func TestAnActionTheOtherAppRefusesIsLoggedAndTheMemberComesBack(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	conv := e.group("g1")
	e.fake.AddHistory("g1", e.msg("m1", lan, "tin 1", 1))
	e.fake.SetMembers("g1", false, tgMember("user:11", "An", false))
	eng, chatID := e.enableWith(conv)
	e.waitTexts(chatID, []string{"tin 1"})
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	e.membersOn(eng, feature.Both)
	e.waitMembers(chatID, "An:member")
	e.fake.FailPin(fmt.Errorf("%w: CHAT_ADMIN_REQUIRED", bridge.ErrNotAllowed))
	if _, err := e.chat.RemoveMember(ctx, e.owner, chatID, e.memberUser(chatID, "An"), false); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool { return e.auditRows("failed") == 1 }, func() string { return "the refusal was not logged" })
	e.waitMembers(chatID, "An:member")
}

func TestTooManyActionsOnPeopleInAnHourAreStoppedAndLogged(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	conv := e.group("g1")
	e.fake.AddHistory("g1", e.msg("m1", lan, "tin 1", 1))
	var members []bridge.Member
	for i := 0; i < 12; i++ {
		members = append(members, tgMember(fmt.Sprintf("user:%d", 100+i), fmt.Sprintf("P%02d", i), false))
	}
	e.fake.SetMembers("g1", false, members...)
	eng, chatID := e.enableWith(conv)
	e.waitTexts(chatID, []string{"tin 1"})
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	e.membersOn(eng, feature.Both)
	e.eventually(func() bool { return len(e.memberRoles(chatID)) == 12 }, func() string { return fmt.Sprint(e.memberRoles(chatID)) })
	for i := 0; i < 12; i++ {
		if _, err := e.chat.RemoveMember(ctx, e.owner, chatID, e.memberUser(chatID, fmt.Sprintf("P%02d", i)), false); err != nil {
			t.Fatal(err)
		}
	}
	e.eventually(func() bool { return e.auditRows("sent") == 10 && e.auditRows("limited") >= 1 }, func() string {
		return fmt.Sprintf("sent=%d limited=%d", e.auditRows("sent"), e.auditRows("limited"))
	})
	time.Sleep(300 * time.Millisecond)
	if n := len(e.fake.MemberCalls()); n != 10 {
		t.Fatalf("%d actions reached the other app, want the limit of 10", n)
	}
}

// chatOnlyMember adds a Chat user who has no account in the other app to the chat.
func (e *env) chatOnlyMember(chatID int64) int64 {
	e.t.Helper()
	ctx := context.Background()
	var id int64
	u, err := e.st.UpsertIdPUser(ctx, "primary", store.IdPProfile{Sub: "acc_only_chat", PreferredUsername: "only_chat", Name: "Chỉ ở Chat"})
	if err != nil {
		e.t.Fatal(err)
	}
	id = u.ID
	if _, err := e.st.Pool().Exec(ctx, `INSERT INTO chat_members (chat_id, user_id, role, inviter_id) VALUES ($1, $2, 'member', $3)`, chatID, id, e.owner); err != nil {
		e.t.Fatal(err)
	}
	if _, err := e.st.Pool().Exec(ctx, `UPDATE chats SET member_count = member_count + 1 WHERE id = $1`, chatID); err != nil {
		e.t.Fatal(err)
	}
	return id
}

func TestAPersonTheOwnerRemovedDoesNotComeBackWhileTheRemovalWaitsToGoOut(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	conv := e.group("g1")
	e.fake.AddHistory("g1", e.msg("m1", lan, "tin 1", 1))
	e.fake.SetMembers("g1", false, tgMember("user:11", "An", false))
	eng, chatID := e.enableWith(conv)
	e.waitTexts(chatID, []string{"tin 1"})
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	e.membersOn(eng, feature.Both)
	e.waitMembers(chatID, "An:member")
	e.fake.FailPin(&bridge.RateLimitError{RetryAfter: 600 * time.Millisecond})
	if _, err := e.chat.RemoveMember(ctx, e.owner, chatID, e.memberUser(chatID, "An"), false); err != nil {
		t.Fatal(err)
	}
	for deadline := time.Now().Add(400 * time.Millisecond); time.Now().Before(deadline); time.Sleep(15 * time.Millisecond) {
		if len(e.memberRoles(chatID)) != 0 {
			t.Fatalf("the person came back while the removal waited: %v", e.memberRoles(chatID))
		}
	}
	e.eventually(func() bool { return len(e.fake.MemberCalls()) == 1 }, func() string { return "the removal never went out" })
}
