// Package profile holds the rules of a chat account's public profile.
//
// Usernames are lowercase ASCII letters, digits and underscore, 3 to 32
// characters, unique within a tenant. New accounts start from the IdP
// preferred_username; on a conflict digits are appended. Names and bios are
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

// usernameFallback is the base used when the IdP name has too few usable
// characters.
const usernameFallback = "user"

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
// result is cut to UsernameMaxLen. Names left shorter than UsernameMinLen
// fall back to "user".
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
	if len(base) < UsernameMinLen {
		return usernameFallback
	}
	return base
}

// sequentialAttempts is how many numbered suffixes (2, 3, ...) are tried
// before switching to random digits.
const sequentialAttempts = 9

// UsernameCandidate returns the username to try on the given attempt
// (0-based): the base itself, then base2..base10, then base followed by six
// random digits. The base is shortened so the result never exceeds
// UsernameMaxLen.
func UsernameCandidate(base string, attempt int) string {
	if attempt == 0 {
		return base
	}
	var suffix string
	if attempt <= sequentialAttempts {
		suffix = strconv.Itoa(attempt + 1)
	} else {
		suffix = randomDigits(6)
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
	return usernameFallback
}
