package telegram

import (
	"testing"

	"github.com/gotd/td/tg"
)

func TestAFullUserStatesTheirPhoneOrThatTheyShowNone(t *testing.T) {
	shown := &tg.User{ID: 7, FirstName: "Anh"}
	shown.SetPhone("84900000001")
	if p := participantUser(shown, selfID); !p.PhoneKnown || p.Phone != "84900000001" {
		t.Fatalf("shown: known = %v, phone set = %v", p.PhoneKnown, p.Phone != "")
	}
	hidden := &tg.User{ID: 8, FirstName: "Bình"}
	if p := participantUser(hidden, selfID); !p.PhoneKnown || p.Phone != "" {
		t.Fatalf("hidden: known = %v, phone set = %v; want known as none", p.PhoneKnown, p.Phone != "")
	}
}

func TestAMinUserLeavesThePhoneUnknown(t *testing.T) {
	u := &tg.User{ID: 7, FirstName: "Anh", Min: true}
	u.SetPhone("84900000001")
	if p := participantUser(u, selfID); p.PhoneKnown || p.Phone != "" {
		t.Fatalf("min user: known = %v, phone set = %v; want unknown", p.PhoneKnown, p.Phone != "")
	}
}

func TestContactsBecomeParticipantsWithoutBots(t *testing.T) {
	person := &tg.User{ID: 7, FirstName: "Anh"}
	person.SetPhone("84900000001")
	bot := &tg.User{ID: 9, FirstName: "Helper", Bot: true}
	got := contactParticipants(&tg.ContactsContacts{Users: []tg.UserClass{person, bot, &tg.UserEmpty{ID: 10}}}, selfID)
	if len(got) != 1 || got[0].ID != "7" || !got[0].PhoneKnown {
		t.Fatalf("contacts = %d; want only the person, with a known phone", len(got))
	}
	if got := contactParticipants(&tg.ContactsContactsNotModified{}, selfID); len(got) != 0 {
		t.Fatalf("not modified gave %d contacts", len(got))
	}
}
