// Package profile holds the rules of a chat account's public profile.
//
// Usernames are lowercase ASCII letters, digits and underscore, 3 to 32
// characters, unique within a tenant. New accounts start from the IdP
// preferred_username; on a conflict, or when that name is too short, digits
// are appended. Names and bios are
// counted in code points (ADR 0004) and may not contain control characters.
package profile

import (
	"crypto/rand"
	"errors"
	"math/big"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Username length bounds.
const (
	UsernameMinLen = 3
	UsernameMaxLen = 32
)

// Name and bio limits in code points.
const (
	NameMaxLen = 64
	BioMaxLen  = 140
)

// Validation failures of names and bios.
var (
	ErrNameEmpty        = errors.New("profile: name is empty")
	ErrNameTooLong      = errors.New("profile: name is too long")
	ErrBioTooLong       = errors.New("profile: bio is too long")
	ErrControlCharacter = errors.New("profile: text contains control characters")
)

// nameFallback is the display name of a new account whose IdP claims carry
// no usable name at all.
const nameFallback = "user"

var usernamePattern = regexp.MustCompile(`^[a-z0-9_]{3,32}$`)

// ValidUsername reports whether u is an acceptable username (already
// lowercase).
func ValidUsername(u string) bool {
	return usernamePattern.MatchString(u)
}

// NormalizeUsername lowercases user input and trims surrounding white space;
// the result still has to pass ValidUsername.
func NormalizeUsername(input string) string {
	return strings.ToLower(strings.TrimSpace(input))
}

// UsernameBase derives the first candidate from an IdP preferred_username:
// lowercase, '-' and '.' become '_', other characters are dropped, and the
// result is cut to UsernameMaxLen. The base may be shorter than
// UsernameMinLen, even empty; UsernameCandidate then pads it with digits.
func UsernameBase(preferred string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(preferred) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '_':
			b.WriteRune(r)
		case r == '-' || r == '.':
			b.WriteByte('_')
		}
	}
	base := b.String()
	if len(base) > UsernameMaxLen {
		base = base[:UsernameMaxLen]
	}
	return base
}

// sequentialAttempts is how many numbered suffixes (2, 3, ...) are tried
// before switching to random digits.
const sequentialAttempts = 9

// UsernameCandidate returns the username to try on the given attempt
// (0-based): the base itself, then base2..base10, then base followed by six
// random digits. A base shorter than UsernameMinLen is never used alone: its
// numbered suffixes start at 1 and get leading zeros up to the minimum length
// ("an" gives an1, an2, ...; "x" gives x01, x02, ...). The base is shortened
// so the result never exceeds UsernameMaxLen.
func UsernameCandidate(base string, attempt int) string {
	short := len(base) < UsernameMinLen
	if attempt == 0 && !short {
		return base
	}
	var suffix string
	switch {
	case attempt > sequentialAttempts:
		suffix = randomDigits(6)
	case short:
		suffix = strconv.Itoa(attempt + 1)
		if pad := UsernameMinLen - len(base) - len(suffix); pad > 0 {
			suffix = strings.Repeat("0", pad) + suffix
		}
	default:
		suffix = strconv.Itoa(attempt + 1)
	}
	if len(base)+len(suffix) > UsernameMaxLen {
		base = base[:UsernameMaxLen-len(suffix)]
	}
	return base + suffix
}

func randomDigits(n int) string {
	var b strings.Builder
	ten := big.NewInt(10)
	for range n {
		d, err := rand.Int(rand.Reader, ten)
		if err != nil {
			// crypto/rand does not fail on supported platforms.
			panic(err)
		}
		b.WriteByte(byte('0' + d.Int64()))
	}
	return b.String()
}

// CleanName trims a display name and validates it.
func CleanName(name string) (string, error) {
	name = strings.TrimSpace(name)
	switch {
	case name == "":
		return "", ErrNameEmpty
	case utf8.RuneCountInString(name) > NameMaxLen:
		return "", ErrNameTooLong
	case strings.IndexFunc(name, unicode.IsControl) >= 0:
		return "", ErrControlCharacter
	}
	return name, nil
}

// CleanBio trims a bio and validates it; line breaks are the only control
// characters allowed.
func CleanBio(bio string) (string, error) {
	bio = strings.TrimSpace(bio)
	switch {
	case utf8.RuneCountInString(bio) > BioMaxLen:
		return "", ErrBioTooLong
	case strings.IndexFunc(bio, func(r rune) bool { return r != '\n' && unicode.IsControl(r) }) >= 0:
		return "", ErrControlCharacter
	}
	return bio, nil
}

// InitialName picks the display name of a new account from the IdP claims:
// name, else preferred_username, else fallback. Control characters are
// replaced by spaces and the result is cut to NameMaxLen code points.
func InitialName(name, preferredUsername, fallback string) string {
	for _, candidate := range []string{name, preferredUsername, fallback} {
		cleaned := strings.TrimSpace(strings.Map(func(r rune) rune {
			if unicode.IsControl(r) {
				return ' '
			}
			return r
		}, candidate))
		if cleaned == "" {
			continue
		}
		if utf8.RuneCountInString(cleaned) > NameMaxLen {
			cleaned = strings.TrimSpace(string([]rune(cleaned)[:NameMaxLen]))
		}
		return cleaned
	}
	return nameFallback
}
