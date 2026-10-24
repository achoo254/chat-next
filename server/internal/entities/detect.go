package entities

import (
	"strings"
	"unicode"
	"unicode/utf16"
)

// Kind names an entity that Detect finds in plain text. The values match
// the TypeScript twin (detectEntities) and the shared vectors in
// spec/entities/detect-vectors.json.
type Kind string

// Kinds found by Detect.
const (
	KindURL     Kind = "url"
	KindEmail   Kind = "email"
	KindMention Kind = "mention"
	KindHashtag Kind = "hashtag"
)

// Found is one detected entity.
type Found struct {
	Kind Kind
	Span
}

// Taken is the span of an entity the text already has. Container marks a
// style entity (bold, italic, underline, strike, spoiler) that a detected
// entity may sit inside; every other entity (code, pre, links, mentions...)
// keeps its text out of detection.
type Taken struct {
	Span
	Container bool
}

// Detect finds web links, e-mail addresses, @mentions and #hashtags in text
// the way Telegram does, so a plain message shows them as links:
//
//   - url: "http://" or "https://" followed by anything up to white space,
//     a control or format character, one of < > " ' ` or "…"; or a bare
//     domain ("hoandat.com", "chat.hoandat.com:8080/abc") whose last label
//     is in the known TLD list (so "file.txt", "v1.2" and "e.g" stay text),
//     with an optional port and path. Trailing . , ; : ! ? are trimmed, and
//     so are closing brackets without an opening one in the link. The link
//     must pass NormalizeLinkURL (http/https without userinfo).
//   - email: local part of ASCII letters, digits and . _ % + - (not starting
//     or ending with '.'), '@' and a domain as above.
//   - mention: '@' and 3 to 32 of a-z, A-Z, 0-9 and '_' (the username rule).
//   - hashtag: '#' and letters, digits, marks and '_', at least one letter
//     (Vietnamese included: "#ĐàLạt").
//
// A candidate starts at the text start or after a character that is not a
// letter, digit, mark or '_' and not one of @ . - / \ # $ % & + = ~ (so the
// "an@hoandat.com" part after '@' is not a mention, "C#" is not a hashtag),
// except a http(s) link, which only needs no letter, digit, mark or '_'
// before it. A domain, e-mail or mention must not be followed by a letter,
// digit, mark, '_' or '@' (cut out of a longer word or an e-mail; links and
// hashtags end where those characters end anyway). No candidate may be
// followed by "…", directly or after trailing punctuation (text cut short,
// such as a truncated webhook message: "https://x.com/report.…").
//
// A candidate is kept only when it overlaps no taken span, or sits wholly
// inside a container one. Text inside a candidate is never searched again,
// so a URL's fragment is not a hashtag. At most limit entities are returned,
// in text order; spans count UTF-16 code units.
func Detect(text string, taken []Taken, appScheme string, limit int) []Found {
	if limit <= 0 || text == "" {
		return nil
	}
	d := detector{runes: []rune(text), taken: taken, appScheme: appScheme}
	d.pos = make([]int, len(d.runes)+1)
	for i, r := range d.runes {
		d.pos[i+1] = d.pos[i] + utf16.RuneLen(r)
	}
	n := len(d.runes)
	for i := 0; i < n && len(d.found) < limit; {
		kind, end, next := d.match(i)
		if next <= i {
			i++
			continue
		}
		if kind != "" {
			d.add(kind, i, end)
		}
		i = next
	}
	return d.found
}

type detector struct {
	runes     []rune
	pos       []int // UTF-16 offset of each rune, plus the end
	taken     []Taken
	appScheme string
	found     []Found
}

// match tries every kind at rune i. kind is "" when the candidate (or
// nothing) was rejected; next is where scanning resumes (i or less: try the
// next rune).
func (d *detector) match(i int) (kind Kind, end, next int) {
	r := d.runes[i]
	if !isASCIIAlnum(r) && r != '@' && r != '#' {
		return "", 0, 0
	}
	var prev rune
	if i > 0 {
		prev = d.runes[i-1]
	}
	if i > 0 && isWordRune(prev) {
		return "", 0, 0
	}
	if end, next := d.schemeURL(i); next > 0 {
		if end > 0 {
			return KindURL, end, end
		}
		return "", 0, next
	}
	if i > 0 && strings.ContainsRune(startExcluded, prev) {
		return "", 0, 0
	}
	switch r {
	case '@':
		if end := d.mention(i); end > 0 {
			return KindMention, end, end
		}
	case '#':
		if end := d.hashtag(i); end > 0 {
			return KindHashtag, end, end
		}
	default:
		if end := d.email(i); end > 0 {
			return KindEmail, end, end
		}
		if end := d.domain(i); end > 0 {
			return KindURL, end, end
		}
	}
	return "", 0, 0
}

// startExcluded: characters that join a candidate to the word before it.
const startExcluded = `@.-/\#$%&+=~`

// cutPunctuation may sit between a candidate and the "…" of a cut text.
const cutPunctuation = ".,;:!?)]}-"

// add keeps the candidate [start, end) (runes) unless "…" follows it, after
// any trailing punctuation, or a taken span is in the way.
func (d *detector) add(kind Kind, start, end int) {
	k := end
	for k < len(d.runes) && strings.ContainsRune(cutPunctuation, d.runes[k]) {
		k++
	}
	if k < len(d.runes) && d.runes[k] == '…' {
		return
	}
	off, stop := d.pos[start], d.pos[end]
	for _, t := range d.taken {
		tEnd := t.Offset + t.Length
		disjoint := stop <= t.Offset || off >= tEnd
		inside := t.Container && t.Offset <= off && stop <= tEnd
		if !disjoint && !inside {
			return
		}
	}
	d.found = append(d.found, Found{Kind: kind, Span: Span{Offset: off, Length: stop - off}})
}

// followedByWord reports a letter, digit, mark, '_' or '@' at rune end: the
// candidate is part of a longer word or an e-mail address.
func (d *detector) followedByWord(end int) bool {
	if end >= len(d.runes) {
		return false
	}
	r := d.runes[end]
	return isWordRune(r) || r == '@'
}

// schemeURL matches "http(s)://..." at i. next is 0 when there is no such
// prefix; otherwise the candidate's extent, and end is 0 when the link is
// not allowed (userinfo, nothing after "//").
func (d *detector) schemeURL(i int) (end, next int) {
	j := i
	for _, prefix := range []string{"https://", "http://"} {
		if d.hasASCIIPrefix(i, prefix) {
			j = i + len(prefix)
			break
		}
	}
	if j == i {
		return 0, 0
	}
	stop := j
	for stop < len(d.runes) && !isURLStop(d.runes[stop]) {
		stop++
	}
	end = trimLinkEnd(d.runes, i, stop)
	if end <= j {
		return 0, stop
	}
	if _, ok := NormalizeLinkURL(string(d.runes[i:end]), d.appScheme); !ok {
		return 0, stop
	}
	return end, stop
}

// hasASCIIPrefix reports prefix (lower-case ASCII) at rune i, in any case.
func (d *detector) hasASCIIPrefix(i int, prefix string) bool {
	if i+len(prefix) > len(d.runes) {
		return false
	}
	for k := 0; k < len(prefix); k++ {
		if asciiLowerRune(d.runes[i+k]) != rune(prefix[k]) {
			return false
		}
	}
	return true
}

// domain matches a bare domain with an optional port and path at i.
func (d *detector) domain(i int) int {
	j, ok := d.host(i)
	if !ok {
		return 0
	}
	if j < len(d.runes) && d.runes[j] == ':' {
		k := j + 1
		for k < len(d.runes) && '0' <= d.runes[k] && d.runes[k] <= '9' {
			k++
		}
		if digits := k - j - 1; digits >= 1 && digits <= 5 && !d.followedByWord(k) {
			j = k
		}
	}
	end := j
	if j < len(d.runes) && strings.ContainsRune("/?#", d.runes[j]) {
		stop := j
		for stop < len(d.runes) && !isURLStop(d.runes[stop]) {
			stop++
		}
		end = max(trimLinkEnd(d.runes, i, stop), j)
	}
	if d.followedByWord(end) {
		return 0
	}
	if _, ok := NormalizeLinkURL(string(d.runes[i:end]), d.appScheme); !ok {
		return 0
	}
	return end
}

// email matches local@domain at i.
func (d *detector) email(i int) int {
	j := i
	for j < len(d.runes) && isEmailLocalRune(d.runes[j]) {
		j++
	}
	if j == i || j >= len(d.runes) || d.runes[j] != '@' || d.runes[i] == '.' || d.runes[j-1] == '.' {
		return 0
	}
	end, ok := d.host(j + 1)
	if !ok || d.followedByWord(end) {
		return 0
	}
	return end
}

// host matches a domain name at i: ASCII labels of letters, digits and '-'
// (not at either end, at most 63 characters) joined by '.', at least two,
// the last one a known TLD. Trailing '.' and '-' are left out. end is the
// rune index after the host.
func (d *detector) host(i int) (end int, ok bool) {
	j := i
	for j < len(d.runes) && (isASCIIAlnum(d.runes[j]) || d.runes[j] == '-' || d.runes[j] == '.') {
		j++
	}
	for j > i && (d.runes[j-1] == '.' || d.runes[j-1] == '-') {
		j--
	}
	if j-i > hostMax {
		return 0, false
	}
	labels := strings.Split(string(d.runes[i:j]), ".")
	if len(labels) < 2 {
		return 0, false
	}
	for _, label := range labels {
		if label == "" || len(label) > labelMax || label[0] == '-' || label[len(label)-1] == '-' {
			return 0, false
		}
	}
	return j, knownTLDs[asciiLower(labels[len(labels)-1])]
}

const (
	hostMax  = 253
	labelMax = 63
)

// mention matches '@' and a username at i.
func (d *detector) mention(i int) int {
	j := i + 1
	for j < len(d.runes) && (isASCIIAlnum(d.runes[j]) || d.runes[j] == '_') {
		j++
	}
	if n := j - i - 1; n < mentionMin || n > mentionMax || d.followedByWord(j) {
		return 0
	}
	return j
}

// Usernames have 3 to 32 characters (server/internal/profile).
const (
	mentionMin = 3
	mentionMax = 32
)

// hashtag matches '#' and a word with at least one letter at i.
func (d *detector) hashtag(i int) int {
	j := i + 1
	letter := false
	for j < len(d.runes) && isWordRune(d.runes[j]) {
		letter = letter || unicode.IsLetter(d.runes[j])
		j++
	}
	if !letter {
		return 0
	}
	return j
}

// trimLinkEnd drops trailing punctuation from the link runes[start:end]:
// . , ; : ! ? always, and a closing bracket that has no opening one left in
// the link ("(see https://x.com/a)" ends at "a", "https://x.com/a_(b)"
// keeps its bracket).
func trimLinkEnd(runes []rune, start, end int) int {
	var open, closed [3]int
	for _, r := range runes[start:end] {
		if k := strings.IndexRune("([{", r); k >= 0 {
			open[k]++
		} else if k := strings.IndexRune(")]}", r); k >= 0 {
			closed[k]++
		}
	}
	for end > start {
		r := runes[end-1]
		if strings.ContainsRune(".,;:!?", r) {
			end--
			continue
		}
		if k := strings.IndexRune(")]}", r); k >= 0 && closed[k] > open[k] {
			closed[k]--
			end--
			continue
		}
		break
	}
	return end
}

// isURLStop: characters that end a link.
func isURLStop(r rune) bool {
	return unicode.In(r, unicode.Cc, unicode.Cf, unicode.White_Space) || strings.ContainsRune("<>\"'`…", r)
}

// isWordRune: letters, decimal digits, marks and '_'.
func isWordRune(r rune) bool {
	return unicode.IsLetter(r) || unicode.Is(unicode.Nd, r) || unicode.IsMark(r) || r == '_'
}

func isASCIIAlnum(r rune) bool {
	return 'a' <= r && r <= 'z' || 'A' <= r && r <= 'Z' || '0' <= r && r <= '9'
}

func isEmailLocalRune(r rune) bool {
	return isASCIIAlnum(r) || strings.ContainsRune("._%+-", r)
}

// asciiLowerRune lower-cases ASCII letters only.
func asciiLowerRune(r rune) rune {
	if 'A' <= r && r <= 'Z' {
		return r + 'a' - 'A'
	}
	return r
}
