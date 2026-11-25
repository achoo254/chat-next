package telegram

import (
	"testing"

	"github.com/gotd/td/tg"
)

func TestAUserWithAPhotoCarriesItsIDAndRef(t *testing.T) {
	u := &tg.User{ID: 7, FirstName: "Anh", Photo: &tg.UserProfilePhoto{PhotoID: 5550}}
	u.SetAccessHash(-42)
	p := participantUser(u, selfID)
	if !p.PhotoKnown || p.PhotoID != "5550" || p.PhotoRef != "user-photo:7:-42:5550" {
		t.Fatalf("participant photo = %v %q %q", p.PhotoKnown, p.PhotoID, p.PhotoRef)
	}
	user, hash, photo, err := parseUserPhotoRef(p.PhotoRef[len(userPhotoRef):])
	if err != nil || user != 7 || hash != -42 || photo != 5550 {
		t.Fatalf("parsed = %d %d %d %v", user, hash, photo, err)
	}
}

func TestAUserWithoutAPhotoIsKnownToHaveNone(t *testing.T) {
	u := &tg.User{ID: 9, Bot: true, FirstName: "Helper"}
	u.SetAccessHash(3)
	p := participantUser(u, selfID)
	if !p.PhotoKnown || p.PhotoID != "" || p.PhotoRef != "" {
		t.Fatalf("participant photo = %v %q %q", p.PhotoKnown, p.PhotoID, p.PhotoRef)
	}
}

func TestAMinUserOrOneWithoutAccessHashLeavesThePhotoUnknown(t *testing.T) {
	minUser := &tg.User{ID: 7, Min: true, Photo: &tg.UserProfilePhoto{PhotoID: 1}}
	minUser.SetAccessHash(5)
	for _, u := range []*tg.User{minUser, {ID: 8, Photo: &tg.UserProfilePhoto{PhotoID: 1}}} {
		if p := participantUser(u, selfID); p.PhotoKnown || p.PhotoRef != "" {
			t.Errorf("user %d: photo = %v %q", u.ID, p.PhotoKnown, p.PhotoRef)
		}
	}
}

func TestABadUserPhotoRefIsRefused(t *testing.T) {
	for _, ref := range []string{"", "7:1", "7:x:1", "7:1:2:3"} {
		if _, _, _, err := parseUserPhotoRef(ref); err == nil {
			t.Errorf("ref %q was accepted", ref)
		}
	}
}
