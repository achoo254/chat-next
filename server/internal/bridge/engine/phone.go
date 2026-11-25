package engine

import (
	"context"
	"fmt"
	"strings"

	"app.local/server/internal/bridge"
	"app.local/server/internal/phone"
)

// phoneHasher is the hasher of the people of the other app.
type phoneHasher struct {
	*phone.Hasher
}

// newPhoneHasher returns nil for an empty key: the phone feature is off.
func newPhoneHasher(key []byte) *phoneHasher {
	h := phone.NewHasher(key)
	if h == nil {
		return nil
	}
	return &phoneHasher{h}
}

// phoneUpdate is what to do with the recorded number of a participant: write
// says whether to touch the column at all, value is the hash to store (nil
// clears it).
type phoneUpdate struct {
	write bool
	value []byte
}

// update decides from what the app said. The app not stating the number, a
// number that cannot be read, or the feature being off all leave the column
// as it is; an empty number the app stated clears it.
func (h *phoneHasher) update(p bridge.Participant) phoneUpdate {
	if h == nil || !p.PhoneKnown {
		return phoneUpdate{}
	}
	if strings.TrimSpace(p.Phone) == "" {
		return phoneUpdate{write: true}
	}
	hash, ok := h.Hash(p.Phone)
	if !ok {
		return phoneUpdate{}
	}
	return phoneUpdate{write: true, value: hash}
}

// setPhone records the number of a person of the account, writing only when it
// changed so a message does not rewrite the row every time.
func (d *db) setPhone(ctx context.Context, accountID int64, p bridge.Participant) error {
	u := d.phones.update(p)
	if !u.write {
		return nil
	}
	if _, err := d.pool.Exec(ctx, `
		UPDATE external_users SET phone_hmac = $3
		WHERE account_id = $1 AND external_user_id = $2 AND phone_hmac IS DISTINCT FROM $3`,
		accountID, p.ID, u.value); err != nil {
		return fmt.Errorf("bridge: record phone: %w", err)
	}
	return nil
}
