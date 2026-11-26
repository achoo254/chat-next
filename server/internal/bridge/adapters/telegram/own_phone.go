package telegram

import (
	"context"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/tg"
)

var _ bridge.OwnPhoneReader = (*Adapter)(nil)

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
