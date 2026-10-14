// Package entities implements the text model of ADR 0004: a message is text
// plus entities whose offset and length count UTF-16 code units, while length
// limits count code points.
//
// The TypeScript twin is packages/core/src/entities; both test suites run the
// shared vectors in spec/entities/test-vectors.json.
package entities

import (
	"cmp"
	"slices"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"
)

// Span is the position of an entity in UTF-16 code units.
type Span struct {
	Offset int
	Length int
}

// ErrorCode names one validation failure. The values match the TypeScript
// implementation and the shared vectors.
type ErrorCode string

// Validation failures, checked in this order for each entity.
const (
	InvalidOffset       ErrorCode = "invalid_offset"
	InvalidLength       ErrorCode = "invalid_length"
	OutOfBounds         ErrorCode = "out_of_bounds"
	SplitsSurrogatePair ErrorCode = "splits_surrogate_pair"
	PartialOverlap      ErrorCode = "partial_overlap"
)

// Error reports the failure of the entity at Index in the input slice.
type Error struct {
	Index int
	Code  ErrorCode
}

// UTF16Length returns the length of text in UTF-16 code units. Invalid UTF-8
// bytes count as one unit each (they decode to U+FFFD).
func UTF16Length(text string) int {
	n := 0
	for _, r := range text {
		n += utf16.RuneLen(r)
	}
	return n
}

// CodePointLength returns the number of code points in text.
func CodePointLength(text string) int {
	return utf8.RuneCountInString(text)
}

// insidePairs returns, indexed by UTF-16 position, whether the position falls
// between the two halves of a surrogate pair. The slice has one extra slot for
// the end position.
func insidePairs(text string) []bool {
	inside := make([]bool, 0, len(text)+1)
	for _, r := range text {
		inside = append(inside, false)
		if utf16.RuneLen(r) == 2 {
			inside = append(inside, true)
		}
	}
	return append(inside, false)
}

// Validate checks entity spans against text. Each entity gets at most one
// error and errors are ordered by entity index. Entities may nest (including
// identical spans) but must not partially overlap: after sorting by (offset
// ascending, end descending, index ascending) the later entity of an
// overlapping pair gets PartialOverlap. Runs in O(n log n).
func Validate(text string, spans []Span) []Error {
	inside := insidePairs(text)
	textLen := len(inside) - 1

	type valid struct{ index, offset, end int }
	var errs []Error
	var ok []valid
	for i, s := range spans {
		var code ErrorCode
		switch {
		case s.Offset < 0:
			code = InvalidOffset
		case s.Length <= 0:
			code = InvalidLength
		case s.Length > textLen-s.Offset:
			code = OutOfBounds
		case inside[s.Offset] || inside[s.Offset+s.Length]:
			code = SplitsSurrogatePair
		default:
			ok = append(ok, valid{i, s.Offset, s.Offset + s.Length})
			continue
		}
		errs = append(errs, Error{Index: i, Code: code})
	}

	slices.SortFunc(ok, func(a, b valid) int {
		return cmp.Or(cmp.Compare(a.offset, b.offset), cmp.Compare(b.end, a.end), cmp.Compare(a.index, b.index))
	})
	// Ends of the currently open (enclosing) entities, innermost last.
	var openEnds []int
	for _, s := range ok {
		for len(openEnds) > 0 && openEnds[len(openEnds)-1] <= s.offset {
			openEnds = openEnds[:len(openEnds)-1]
		}
		if len(openEnds) > 0 && s.end > openEnds[len(openEnds)-1] {
			errs = append(errs, Error{Index: s.index, Code: PartialOverlap})
			continue
		}
		openEnds = append(openEnds, s.end)
	}

	slices.SortFunc(errs, func(a, b Error) int { return cmp.Compare(a.Index, b.Index) })
	return errs
}

// IsAllowedURL allows only http:, https:, mailto: and appScheme
// (case-insensitive). Relative and scheme-relative URLs are rejected, as are
// URLs containing control, format or whitespace characters anywhere:
// browsers strip some of them, so "java\tscript:" would run as javascript:.
// http(s) URLs with userinfo are rejected (see isWebURL). App-scheme links into the sign-in callback routes (/auth/...) are rejected
// too; see targetsAuthRoute.
func IsAllowedURL(url, appScheme string) bool {
	scheme, rest, ok := parseURL(url)
	if !ok {
		return false
	}
	switch scheme {
	case "http", "https":
		return isWebURL(scheme, rest)
	case "mailto":
		return rest != ""
	default:
		return isSchemeName(appScheme) && scheme == strings.ToLower(appScheme) && rest != "" &&
			!targetsAuthRoute(rest)
	}
}

// IsAllowedWebURL allows only absolute http: and https: URLs without
// userinfo. Use it for URLs
// that are fetched or embedded rather than opened by the user: thumbnail_url,
// mini_app_url and webhook targets.
func IsAllowedWebURL(url string) bool {
	scheme, rest, ok := parseURL(url)
	return ok && isWebURL(scheme, rest)
}

// NormalizeLinkURL turns the visible text of a url entity into the URL it
// opens: it trims Unicode White_Space, prefixes "https://" when the text has
// no scheme ("example.com", "localhost:3000"), then applies IsAllowedURL. ok
// is false when the result is not allowed.
func NormalizeLinkURL(text, appScheme string) (url string, ok bool) {
	trimmed := strings.TrimFunc(text, isWhiteSpace)
	if trimmed == "" {
		return "", false
	}
	url = trimmed
	if !hasScheme(trimmed) {
		url = "https://" + trimmed
	}
	if !IsAllowedURL(url, appScheme) {
		return "", false
	}
	return url, true
}

// parseURL rejects invalid UTF-8 and forbidden characters, then splits url
// into its lower-cased scheme and the rest after the colon.
func parseURL(url string) (scheme, rest string, ok bool) {
	if !utf8.ValidString(url) {
		return "", "", false
	}
	for _, r := range url {
		if unicode.In(r, unicode.Cc, unicode.Cf, unicode.White_Space) {
			return "", "", false
		}
	}
	colon := strings.IndexByte(url, ':')
	if colon < 0 || !isSchemeName(url[:colon]) {
		return "", "", false
	}
	return strings.ToLower(url[:colon]), url[colon+1:], true
}

// isWebURL reports an http(s) URL with a non-empty authority and no
// userinfo. Userinfo ("https://google.com@evil.com") shows one host and opens
// another, so any '@' in the authority, literal or percent-encoded, is
// rejected. The authority ends only at '/', '?' or '#' (not backslash), so a
// parser that does not treat backslash as a separator cannot find userinfo
// that this check missed.
func isWebURL(scheme, rest string) bool {
	if scheme != "http" && scheme != "https" ||
		len(rest) <= 2 || !strings.HasPrefix(rest, "//") || strings.ContainsRune("/?#", rune(rest[2])) {
		return false
	}
	authority := rest[2:]
	if end := strings.IndexAny(authority, "/?#"); end >= 0 {
		authority = authority[:end]
	}
	return !strings.Contains(authority, "@") && !strings.Contains(strings.ToLower(authority), "%40")
}

// hasScheme reports whether link text starts with a scheme. A scheme-less
// "host:port" (localhost:3000, example.com:8080/x) also looks like one, so a
// port of 1 to 5 digits ending the text or followed by '/', '?' or '#' marks
// a host instead.
func hasScheme(text string) bool {
	colon := strings.IndexByte(text, ':')
	if colon < 0 || !isSchemeName(text[:colon]) {
		return false
	}
	rest := text[colon+1:]
	digits := 0
	for digits < len(rest) && '0' <= rest[digits] && rest[digits] <= '9' {
		digits++
	}
	isPort := digits >= 1 && digits <= 5 && (digits == len(rest) || strings.IndexByte("/?#", rest[digits]) >= 0)
	return !isPort
}

// authSegment is the app route that belongs to the sign-in flow (ADR 0006).
const authSegment = "auth"

// targetsAuthRoute reports whether an app-scheme link reaches the sign-in
// callback area (com.hoandat.chat:/auth/callback), which only the system
// browser may open. Deep-link routers differ in how they read the authority,
// letter case and escapes, so this covers every reading: the part before '?'
// or '#' is percent-decoded, split at '/' and backslash, and any segment
// whose name (without userinfo before '@' or anything from ':' or ';') is
// "auth" in any ASCII case matches. A malformed escape also matches.
func targetsAuthRoute(rest string) bool {
	if end := strings.IndexAny(rest, "?#"); end >= 0 {
		rest = rest[:end]
	}
	decoded, ok := percentDecode(rest)
	if !ok {
		return true
	}
	for _, segment := range strings.FieldsFunc(decoded, func(r rune) bool { return r == '/' || r == '\\' }) {
		if at := strings.LastIndexByte(segment, '@'); at >= 0 {
			segment = segment[at+1:]
		}
		if end := strings.IndexAny(segment, ":;"); end >= 0 {
			segment = segment[:end]
		}
		if asciiLower(segment) == authSegment {
			return true
		}
	}
	return false
}

// percentDecode decodes every %XX escape to its byte. ok is false when a '%'
// is not followed by two hex digits.
func percentDecode(s string) (decoded string, ok bool) {
	if !strings.Contains(s, "%") {
		return s, true
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		if s[i] != '%' {
			b.WriteByte(s[i])
			continue
		}
		if i+2 >= len(s) {
			return "", false
		}
		hi, okHi := hexValue(s[i+1])
		lo, okLo := hexValue(s[i+2])
		if !okHi || !okLo {
			return "", false
		}
		b.WriteByte(hi<<4 | lo)
		i += 2
	}
	return b.String(), true
}

func hexValue(c byte) (byte, bool) {
	switch {
	case '0' <= c && c <= '9':
		return c - '0', true
	case 'a' <= c && c <= 'f':
		return c - 'a' + 10, true
	case 'A' <= c && c <= 'F':
		return c - 'A' + 10, true
	}
	return 0, false
}

// asciiLower lower-cases ASCII letters only, so every byte sequence compares
// the same way as in the TypeScript twin.
func asciiLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if 'A' <= c && c <= 'Z' {
			b[i] = c + 'a' - 'A'
		}
	}
	return string(b)
}

func isWhiteSpace(r rune) bool {
	return unicode.Is(unicode.White_Space, r)
}

// isSchemeName reports whether s matches RFC 3986
// ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ).
func isSchemeName(s string) bool {
	if s == "" || !isASCIILetter(s[0]) {
		return false
	}
	for i := 1; i < len(s); i++ {
		c := s[i]
		isDigit := '0' <= c && c <= '9'
		if !isASCIILetter(c) && !isDigit && c != '+' && c != '-' && c != '.' {
			return false
		}
	}
	return true
}

func isASCIILetter(c byte) bool {
	return 'a' <= c && c <= 'z' || 'A' <= c && c <= 'Z'
}
