package format

import (
	"crypto/sha256"
	"encoding/hex"
	"html"
	"regexp"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/entities"
)

// builder accumulates message text and its entities; offsets and lengths
// count UTF-16 code units (ADR 0004).
type builder struct {
	sb   strings.Builder
	n    int
	ents []*appv1.MessageEntity
	opts Options
}

func newBuilder(opts Options) *builder {
	return &builder{opts: opts}
}

// cleanText makes s valid UTF-8 without NUL and with \n line ends.
func cleanText(s string) string {
	s = strings.ToValidUTF8(s, "�")
	s = strings.ReplaceAll(s, "\x00", "")
	s = strings.ReplaceAll(s, "\r\n", "\n")
	return strings.ReplaceAll(s, "\r", "\n")
}

func (b *builder) write(s string) {
	b.sb.WriteString(s)
	b.n += entities.UTF16Length(s)
}

func (b *builder) empty() bool {
	return b.n == 0
}

// newline ends the current line unless the text is empty or already ends
// with one.
func (b *builder) newline() {
	if b.n > 0 && !strings.HasSuffix(b.sb.String(), "\n") {
		b.write("\n")
	}
}

// mark adds an entity of type t from start to the current end, when not
// empty.
func (b *builder) mark(t appv1.EntityType, start int) *appv1.MessageEntity {
	if b.n <= start {
		return nil
	}
	e := &appv1.MessageEntity{Type: t, Offset: int32(start), Length: int32(b.n - start)}
	b.ents = append(b.ents, e)
	return e
}

func (b *builder) styled(t appv1.EntityType, s string) {
	start := b.n
	b.write(s)
	b.mark(t, start)
}

// link writes label linked to url when url is allowed, or label alone.
func (b *builder) link(label, url string) {
	if label == "" {
		label = url
	}
	start := b.n
	b.write(label)
	if entities.IsAllowedURL(url, b.opts.AppScheme) {
		if e := b.mark(appv1.EntityType_ENTITY_TYPE_TEXT_LINK, start); e != nil {
			e.Url = url
		}
	}
}

// line writes "label: value" on its own line; value is plain text.
func (b *builder) field(label, value string) {
	if strings.TrimSpace(value) == "" {
		return
	}
	b.newline()
	b.write(label + ": ")
	b.write(value)
}

const preTitleMax = 32

// pre writes a code block; a short first line ("```title\n...") becomes its
// language, shown as the block title.
func (b *builder) pre(inner string) {
	lang := ""
	if i := strings.IndexByte(inner, '\n'); i >= 0 {
		first := strings.TrimSpace(inner[:i])
		if utf8.RuneCountInString(first) <= preTitleMax {
			lang, inner = first, inner[i+1:]
		}
	}
	inner = strings.TrimSuffix(inner, "\n")
	if inner == "" {
		inner, lang = lang, ""
	}
	if inner == "" {
		return
	}
	b.newline()
	start := b.n
	b.write(inner)
	if e := b.mark(appv1.EntityType_ENTITY_TYPE_PRE, start); e != nil {
		e.Language = lang
	}
}

// ----------------------------------------------------------- markdown

// dialect selects the markup of a payload. Both understand *bold*,
// **bold**, _italic_, ~strike~, ~~strike~~, `code`, ```pre``` and
// [label](url) (Mattermost, so GitLab). Slack adds <url|label> links,
// <!here>-style tokens and &amp;/&lt;/&gt; escapes; markdown (Telegram
// style) adds __underline__, ||spoiler|| and backslash escapes.
type dialect int

const (
	dialectSlack dialect = iota
	dialectMarkdown
)

const markdownDepthMax = 4

type delimiter struct {
	token string
	slack appv1.EntityType
	md    appv1.EntityType
}

// delimiters are tried in order: longer tokens first.
var delimiters = []delimiter{
	{"**", appv1.EntityType_ENTITY_TYPE_BOLD, appv1.EntityType_ENTITY_TYPE_BOLD},
	{"__", appv1.EntityType_ENTITY_TYPE_BOLD, appv1.EntityType_ENTITY_TYPE_UNDERLINE},
	{"~~", appv1.EntityType_ENTITY_TYPE_STRIKE, appv1.EntityType_ENTITY_TYPE_STRIKE},
	{"||", appv1.EntityType_ENTITY_TYPE_UNSPECIFIED, appv1.EntityType_ENTITY_TYPE_SPOILER},
	{"*", appv1.EntityType_ENTITY_TYPE_BOLD, appv1.EntityType_ENTITY_TYPE_BOLD},
	{"_", appv1.EntityType_ENTITY_TYPE_ITALIC, appv1.EntityType_ENTITY_TYPE_ITALIC},
	{"~", appv1.EntityType_ENTITY_TYPE_STRIKE, appv1.EntityType_ENTITY_TYPE_STRIKE},
}

// markup writes s parsed in dialect d.
func (b *builder) markup(s string, d dialect) {
	b.markupDepth(cleanText(s), d, 0)
}

func (b *builder) markupDepth(s string, d dialect, depth int) {
	var plain strings.Builder
	flush := func() {
		if plain.Len() == 0 {
			return
		}
		text := plain.String()
		plain.Reset()
		if d == dialectSlack {
			text = html.UnescapeString(text)
		}
		b.write(text)
	}
	unescape := func(t string) string {
		if d == dialectSlack {
			return html.UnescapeString(t)
		}
		return t
	}
	for i := 0; i < len(s); {
		rest := s[i:]
		if d == dialectMarkdown && rest[0] == '\\' && len(rest) > 1 && isASCIIPunct(rest[1]) {
			plain.WriteByte(rest[1])
			i += 2
			continue
		}
		if strings.HasPrefix(rest, "```") {
			if end := strings.Index(rest[3:], "```"); end >= 0 {
				flush()
				b.pre(unescape(rest[3 : 3+end]))
				i += 3 + end + 3
				continue
			}
		}
		if rest[0] == '`' {
			if end := strings.IndexByte(rest[1:], '`'); end > 0 && !strings.Contains(rest[1:1+end], "\n") {
				flush()
				b.styled(appv1.EntityType_ENTITY_TYPE_CODE, unescape(rest[1:1+end]))
				i += end + 2
				continue
			}
		}
		if d == dialectSlack && rest[0] == '<' {
			if end := strings.IndexByte(rest[1:], '>'); end > 0 && !strings.Contains(rest[1:1+end], "\n") {
				flush()
				b.slackToken(rest[1 : 1+end])
				i += end + 2
				continue
			}
		}
		if rest[0] == '[' {
			if label, url, n, ok := markdownLink(rest); ok {
				flush()
				start := b.n
				if depth < markdownDepthMax {
					b.markupDepth(label, d, depth+1)
				} else {
					b.write(unescape(label))
				}
				url = unescape(url)
				if entities.IsAllowedURL(url, b.opts.AppScheme) {
					if e := b.mark(appv1.EntityType_ENTITY_TYPE_TEXT_LINK, start); e != nil {
						e.Url = url
					}
				}
				i += n
				continue
			}
		}
		if depth < markdownDepthMax {
			if n, ok := b.delimited(s, i, d, depth, flush); ok {
				i += n
				continue
			}
		}
		plain.WriteByte(rest[0])
		i++
	}
	flush()
}

// delimited parses a delimited span (bold, italic...) starting at s[i];
// it returns the bytes consumed.
func (b *builder) delimited(s string, i int, d dialect, depth int, flush func()) (int, bool) {
	for _, del := range delimiters {
		t := del.slack
		if d == dialectMarkdown {
			t = del.md
		}
		if t == appv1.EntityType_ENTITY_TYPE_UNSPECIFIED || !strings.HasPrefix(s[i:], del.token) {
			continue
		}
		if !leftFlanking(s, i, len(del.token)) {
			return 0, false
		}
		from := i + len(del.token)
		for j := from; j < len(s); {
			k := strings.Index(s[j:], del.token)
			if k < 0 {
				break
			}
			end := j + k
			if strings.Contains(s[from:end], "\n") {
				break
			}
			if end > from && rightFlanking(s, end, len(del.token)) {
				flush()
				start := b.n
				b.markupDepth(s[from:end], d, depth+1)
				b.mark(t, start)
				return end + len(del.token) - i, true
			}
			j = end + 1
		}
		return 0, false
	}
	return 0, false
}

// leftFlanking: a delimiter at s[i] opens a span when the next rune is not
// a space and the previous rune is not a letter or digit (snake_case and
// 2*3*4 stay plain).
func leftFlanking(s string, i, n int) bool {
	if i+n >= len(s) {
		return false
	}
	if next, _ := utf8.DecodeRuneInString(s[i+n:]); unicode.IsSpace(next) {
		return false
	}
	if i == 0 {
		return true
	}
	prev, _ := utf8.DecodeLastRuneInString(s[:i])
	return !unicode.IsLetter(prev) && !unicode.IsDigit(prev)
}

// rightFlanking: a delimiter at s[j] closes a span when the previous rune is
// not a space and the next rune is not a letter or digit.
func rightFlanking(s string, j, n int) bool {
	prev, _ := utf8.DecodeLastRuneInString(s[:j])
	if unicode.IsSpace(prev) {
		return false
	}
	if j+n >= len(s) {
		return true
	}
	next, _ := utf8.DecodeRuneInString(s[j+n:])
	return !unicode.IsLetter(next) && !unicode.IsDigit(next)
}

func isASCIIPunct(c byte) bool {
	return c < utf8.RuneSelf && (unicode.IsPunct(rune(c)) || unicode.IsSymbol(rune(c)))
}

// markdownLink parses [label](url) at the start of s.
func markdownLink(s string) (label, url string, n int, ok bool) {
	closeLabel := strings.Index(s, "](")
	if closeLabel <= 1 || strings.Contains(s[:closeLabel], "\n") {
		return "", "", 0, false
	}
	end := strings.IndexByte(s[closeLabel+2:], ')')
	if end <= 0 {
		return "", "", 0, false
	}
	url = s[closeLabel+2 : closeLabel+2+end]
	if strings.ContainsAny(url, " \n\t") {
		return "", "", 0, false
	}
	return s[1:closeLabel], url, closeLabel + 2 + end + 1, true
}

// slackToken writes the inside of <...>: a link (<url>, <url|label>), a
// broadcast (<!here>), a user, channel or group mention, or a date.
func (b *builder) slackToken(inner string) {
	target, label, hasLabel := strings.Cut(inner, "|")
	label = html.UnescapeString(label)
	switch {
	case strings.HasPrefix(target, "!"):
		switch {
		case hasLabel:
			b.write(label)
		case target == "!here" || target == "!channel" || target == "!everyone":
			b.write("@" + target[1:])
		default:
		}
	case strings.HasPrefix(target, "@") || strings.HasPrefix(target, "#"):
		if hasLabel {
			b.write(target[:1] + strings.TrimLeft(label, "@#"))
		} else {
			b.write(target)
		}
	default:
		b.link(label, html.UnescapeString(target))
	}
}

// ------------------------------------------------------------ finishing

var bareURL = regexp.MustCompile(`https?://[^\s<>"'` + "`" + `]+`)

// linkable: entities a bare URL may sit inside.
var linkable = map[appv1.EntityType]bool{
	appv1.EntityType_ENTITY_TYPE_BOLD:      true,
	appv1.EntityType_ENTITY_TYPE_ITALIC:    true,
	appv1.EntityType_ENTITY_TYPE_UNDERLINE: true,
	appv1.EntityType_ENTITY_TYPE_STRIKE:    true,
	appv1.EntityType_ENTITY_TYPE_SPOILER:   true,
}

// autolink marks bare web URLs that no link or code entity covers.
func autolink(text string, ents []*appv1.MessageEntity, appScheme string) []*appv1.MessageEntity {
	for _, loc := range bareURL.FindAllStringIndex(text, 50) {
		raw := strings.TrimRight(text[loc[0]:loc[1]], ".,;:!?)]}")
		if _, ok := entities.NormalizeLinkURL(raw, appScheme); !ok {
			continue
		}
		off := entities.UTF16Length(text[:loc[0]])
		end := off + entities.UTF16Length(raw)
		free := true
		for _, e := range ents {
			eo, ee := int(e.GetOffset()), int(e.GetOffset()+e.GetLength())
			disjoint := end <= eo || off >= ee
			inside := linkable[e.GetType()] && eo <= off && end <= ee
			if !disjoint && !inside {
				free = false
				break
			}
		}
		if free {
			ents = append(ents, &appv1.MessageEntity{Type: appv1.EntityType_ENTITY_TYPE_URL, Offset: int32(off), Length: int32(end - off)})
		}
	}
	return ents
}

// truncate cuts text to max code points (ending with "…") and clips the
// entities to it; links cut in the middle are dropped.
func truncate(text string, ents []*appv1.MessageEntity, max int) (string, []*appv1.MessageEntity) {
	if entities.CodePointLength(text) <= max {
		return text, ents
	}
	cut, runes := 0, 0
	for cut < len(text) && runes < max-1 {
		_, size := utf8.DecodeRuneInString(text[cut:])
		cut += size
		runes++
	}
	limit := entities.UTF16Length(text[:cut])
	out := make([]*appv1.MessageEntity, 0, len(ents))
	for _, e := range ents {
		off, end := int(e.GetOffset()), int(e.GetOffset()+e.GetLength())
		switch {
		case off >= limit:
			continue
		case end > limit:
			if e.GetType() == appv1.EntityType_ENTITY_TYPE_URL {
				continue
			}
			e.Length = int32(limit - off)
		}
		out = append(out, e)
	}
	return text[:cut] + "…", out
}

// finish returns the text and entities of b, rejecting an empty text and,
// when strict, a text over the length limit (otherwise truncated).
func (b *builder) finish(strict bool) (string, []*appv1.MessageEntity, error) {
	text, ents := b.sb.String(), b.ents
	// Drop trailing blank space no entity uses.
	last := 0
	for _, e := range ents {
		last = max(last, int(e.GetOffset()+e.GetLength()))
	}
	trimmed := strings.TrimRightFunc(text, unicode.IsSpace)
	if entities.UTF16Length(trimmed) >= last {
		text = trimmed
	}
	if strings.TrimSpace(text) == "" {
		return "", nil, errorf("text_empty", "the payload has no text to post")
	}
	ents = autolink(text, ents, b.opts.AppScheme)
	slices.SortStableFunc(ents, func(x, y *appv1.MessageEntity) int { return int(x.GetOffset() - y.GetOffset()) })
	if b.opts.MaxLength > 0 && entities.CodePointLength(text) > b.opts.MaxLength {
		if strict {
			return "", nil, errorf("text_too_long", "text is longer than %d characters", b.opts.MaxLength)
		}
		text, ents = truncate(text, ents, b.opts.MaxLength)
	}
	return text, ents, nil
}

// hashKey shortens a long group key without losing uniqueness.
func hashKey(key string) string {
	sum := sha256.Sum256([]byte(key))
	return "sha256:" + hex.EncodeToString(sum[:])
}

// firstNonEmpty returns the first argument that is not blank.
func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
