// Package phone writes phone numbers in one form and hashes them under a key that is not in
// the database, so two apps' numbers for one person can be matched without keeping the number.
package phone

import (
	"crypto/hmac"
	"crypto/sha256"
	"strings"
)

// defaultCountryCode is the calling code of a number written in national form
// (a leading trunk 0): the people of this service are in Vietnam.
const defaultCountryCode = "84"

// E.164 bounds: at most 15 digits after "+", and no real number is shorter than 8.
const (
	e164DigitsMin = 8
	e164DigitsMax = 15
)

// Normalize writes a phone number the way an app gives it in E.164 form
// ("+84912345678"), or reports false for anything that is not plainly a phone
// number. Spaces, dots, dashes and brackets are dropped. Forms:
//   - "+<country><number>" and "00<country><number>": international.
//   - "0<number>": national, in defaultCountryCode.
//   - other digits: international without "+" (how Telegram and Zalo give them).
//
// A Vietnamese number must have 9 or 10 digits after +84.
func Normalize(raw string) (string, bool) {
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

// Hasher turns a phone number into what the phone_hmac columns keep: HMAC-SHA256 of its E.164
// form under a key that is not in the database. A nil Hasher (no key configured) keeps nothing.
type Hasher struct {
	key []byte
}

// NewHasher returns nil for an empty key: the phone feature is off.
func NewHasher(key []byte) *Hasher {
	if len(key) == 0 {
		return nil
	}
	return &Hasher{key: append([]byte(nil), key...)}
}

// Hash is the keyed hash of a number written in any plain form. ok is false when the number
// cannot be read or there is no key.
func (h *Hasher) Hash(raw string) (hash []byte, ok bool) {
	if h == nil {
		return nil, false
	}
	e164, ok := Normalize(raw)
	if !ok {
		return nil, false
	}
	mac := hmac.New(sha256.New, h.key)
	mac.Write([]byte(e164))
	return mac.Sum(nil), true
}
