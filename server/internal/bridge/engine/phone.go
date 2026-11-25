package engine

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"fmt"
	"strings"

	"app.local/server/internal/bridge"
)

// defaultCountryCode is the calling code of a number written in national form
// (a leading trunk 0): the people of this service are in Vietnam.
const defaultCountryCode = "84"

// E.164 bounds: at most 15 digits after "+", and no real number is shorter than 8.
const (
	e164DigitsMin = 8
	e164DigitsMax = 15
)

// normalizePhone writes a phone number the way an app gives it in E.164 form
// ("+84912345678"), or reports false for anything that is not plainly a phone
// number. Spaces, dots, dashes and brackets are dropped. Forms:
//   - "+<country><number>" and "00<country><number>": international.
//   - "0<number>": national, in defaultCountryCode.
//   - other digits: international without "+" (how Telegram and Zalo give them).
//
// A Vietnamese number must have 9 or 10 digits after +84.
func normalizePhone(raw string) (string, bool) {
	var digits strings.Builder
	plus := false
	for i, r := range strings.TrimSpace(raw) {
		switch {
		case r >= '0' && r <= '9':
			digits.WriteRune(r)
		case r == '+' && i == 0:
			plus = true
		case r == ' ' || r == '.' || r == '-' || r == '(' || r == ')':
		default:
			return "", false // letters, extensions, * or #: not a plain number
		}
	}
	d := digits.String()
	switch {
	case plus:
	case strings.HasPrefix(d, "00"):
		d = d[2:]
	case strings.HasPrefix(d, "0"):
		d = defaultCountryCode + d[1:]
	}
	if len(d) < e164DigitsMin || len(d) > e164DigitsMax || d[0] == '0' {
		return "", false
	}
	if national, ok := strings.CutPrefix(d, defaultCountryCode); ok {
		if len(national) < 9 || len(national) > 10 || national[0] == '0' {
			return "", false
		}
	}
	return "+" + d, true
}

// phoneHasher turns a phone number into what external_users.phone_hmac keeps:
// HMAC-SHA256 of its E.164 form under a key that is not in the database. A nil
// hasher (no key configured) keeps nothing.
type phoneHasher struct {
	key []byte
}

// newPhoneHasher returns nil for an empty key: the phone feature is off.
func newPhoneHasher(key []byte) *phoneHasher {
	if len(key) == 0 {
		return nil
	}
	return &phoneHasher{key: append([]byte(nil), key...)}
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
	e164, ok := normalizePhone(p.Phone)
	if !ok {
		return phoneUpdate{}
	}
	mac := hmac.New(sha256.New, h.key)
	mac.Write([]byte(e164))
	return phoneUpdate{write: true, value: mac.Sum(nil)}
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
