package telegram

import (
	"testing"

	"github.com/gotd/td/tg"
)

func TestMembersOfAGroupKeepOnlyLivePeopleWithTheirRole(t *testing.T) {
	users := []tg.UserClass{
		&tg.User{ID: 1, FirstName: "An"},
		&tg.User{ID: 2, FirstName: "Bình", Username: "binh"},
		&tg.User{ID: 3, FirstName: "Đã xoá", Deleted: true},
		&tg.User{ID: 9, FirstName: "Chủ"},
	}
	got := membersOf(users, map[int64]bool{2: true}, []int64{1, 2, 3, 4, 9}, 9)
	if len(got) != 3 {
		t.Fatalf("members = %+v, want the three live people (a deleted account and an unseen id are left out)", got)
	}
	if got[0].Participant.ID != "1" || got[0].Admin || !got[1].Admin || got[1].Participant.Username != "binh" {
		t.Fatalf("members = %+v", got)
	}
	if !got[2].Participant.IsSelf {
		t.Fatal("the account owner is not marked, so the engine would add them as a puppet")
	}
}

func TestAMemberNeverSeenInTheGroupCannotBeActedOn(t *testing.T) {
	c := &conn{hashes: map[int64]int64{}}
	if _, err := c.inputUser("42"); err == nil {
		t.Fatal("a person with no access hash was acted on")
	}
	c.rememberUsers([]tg.UserClass{&tg.User{ID: 42, AccessHash: 7}})
	u, err := c.inputUser("42")
	if err != nil || u.AccessHash != 7 {
		t.Fatalf("after listing the group: %+v, %v", u, err)
	}
	if _, err := c.inputUser("x"); err == nil {
		t.Fatal("a bad id was accepted")
	}
}
