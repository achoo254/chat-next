package telegram

import (
	"context"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/tg"
)

var (
	_ bridge.PhoneBook      = (*Adapter)(nil)
	_ bridge.OwnPhoneReader = (*Adapter)(nil)
)

// withUserPhone fills the phone number of a participant from the user Telegram sent. A
// full user states the number the account may see (none when the person hides it), so
// it is known; a "min" user leaves fields out, so the number stays unknown and the one
// recorded is kept.
func withUserPhone(p *bridge.Participant, u *tg.User) {
	if u.Min {
		return
	}
	p.PhoneKnown = true
	p.Phone, _ = u.GetPhone()
}

// PhoneContacts implements bridge.PhoneBook with contacts.getContacts, which only reads
// the account's contact list.
func (a *Adapter) PhoneContacts(ctx context.Context, acct bridge.Account) ([]bridge.Participant, error) {
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return nil, err
	}
	defer release()
	res, err := c.live.api().ContactsGetContacts(ctx, 0)
	if err != nil {
		return nil, translate(err)
	}
	return contactParticipants(res, c.live.self), nil
}

// contactParticipants maps a contacts.getContacts answer; "not modified" (only possible
// with a hash, which is never sent) is no contacts.
func contactParticipants(res tg.ContactsContactsClass, self int64) []bridge.Participant {
	list, ok := res.(*tg.ContactsContacts)
	if !ok {
		return nil
	}
	out := make([]bridge.Participant, 0, len(list.Users))
	for _, uc := range list.Users {
		if u, ok := uc.(*tg.User); ok && !u.Bot {
			out = append(out, participantUser(u, self))
		}
	}
	return out
}

// OwnPhone implements bridge.OwnPhoneReader: the number of the logged-in account, which
// Telegram verified by SMS when the account was made.
func (a *Adapter) OwnPhone(ctx context.Context, acct bridge.Account) (string, error) {
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return "", err
	}
	defer release()
	users, err := c.live.api().UsersGetUsers(ctx, []tg.InputUserClass{&tg.InputUserSelf{}})
	if err != nil {
		return "", translate(err)
	}
	for _, uc := range users {
		if u, ok := uc.(*tg.User); ok && u.Self {
			phone, _ := u.GetPhone()
			return phone, nil
		}
	}
	return "", nil
}
