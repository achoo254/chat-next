package format

import (
	"strconv"
	"strings"
	"unicode/utf8"

	appv1 "app.local/server/gen/app/v1"
)

// HTML tags (spec/bot-api/format.md):
//
//	<b> <strong>  <i> <em>  <u> <ins>  <s> <strike> <del>
//	<span class="spoiler"> <spoiler>  <code>  <pre> (optionally holding
//	<code class="language-x">)  <a href="url">
//
// Character references: &lt; &gt; &amp; &quot; &apos; and numeric ones.
// A literal "<" must be written &lt;. Any other tag or attribute is an
// error. Inside <code> and <pre> no tag may open (except the one <code>
// directly inside <pre>).

var htmlTags = map[string]appv1.EntityType{
	"b": appv1.EntityType_ENTITY_TYPE_BOLD, "strong": appv1.EntityType_ENTITY_TYPE_BOLD,
	"i": appv1.EntityType_ENTITY_TYPE_ITALIC, "em": appv1.EntityType_ENTITY_TYPE_ITALIC,
	"u": appv1.EntityType_ENTITY_TYPE_UNDERLINE, "ins": appv1.EntityType_ENTITY_TYPE_UNDERLINE,
	"s": appv1.EntityType_ENTITY_TYPE_STRIKE, "strike": appv1.EntityType_ENTITY_TYPE_STRIKE,
	"del":  appv1.EntityType_ENTITY_TYPE_STRIKE,
	"span": appv1.EntityType_ENTITY_TYPE_SPOILER, "spoiler": appv1.EntityType_ENTITY_TYPE_SPOILER,
	"code": appv1.EntityType_ENTITY_TYPE_CODE, "pre": appv1.EntityType_ENTITY_TYPE_PRE,
	"a": appv1.EntityType_ENTITY_TYPE_TEXT_LINK,
}

var namedRefs = map[string]rune{"lt": '<', "gt": '>', "amp": '&', "quot": '"', "apos": '\''}

type htmlOpen struct {
	name  string
	kind  appv1.EntityType
	start int
	at    int
	url   string
	lang  string
	// codeInPre: a <code> directly inside <pre>; it only names the language.
	codeInPre bool
}

// HTML parses src in the HTML subset.
func HTML(src string, opts Options) (string, []*appv1.MessageEntity, error) {
	if err := checkSource(src); err != nil {
		return "", nil, err
	}
	b := &builder{}
	var stack []htmlOpen
	inCode := func() bool {
		for _, o := range stack {
			if o.kind == appv1.EntityType_ENTITY_TYPE_CODE || o.kind == appv1.EntityType_ENTITY_TYPE_PRE {
				return true
			}
		}
		return false
	}
	for i := 0; i < len(src); {
		switch src[i] {
		case '&':
			r, n, ok := ampersand(src[i:])
			if !ok {
				return "", nil, errAt(i, "unknown character reference; write & as &amp;")
			}
			b.writeRune(r)
			i += n
		case '<':
			t, n, err := readTag(src, i)
			if err != nil {
				return "", nil, err
			}
			if t.closing {
				if len(stack) == 0 || stack[len(stack)-1].name != t.name {
					return "", nil, errAt(i, "</%s> does not close the innermost open tag", t.name)
				}
				o := stack[len(stack)-1]
				stack = stack[:len(stack)-1]
				if !o.codeInPre {
					if e := b.entity(o.kind, o.start); e != nil {
						e.Url, e.Language = o.url, o.lang
					} else if o.kind == appv1.EntityType_ENTITY_TYPE_TEXT_LINK {
						return "", nil, errAt(o.at, "a link needs text")
					}
				}
				i += n
				continue
			}
			kind, ok := htmlTags[t.name]
			if !ok {
				return "", nil, errAt(i, "unsupported tag <%s>", t.name)
			}
			o := htmlOpen{name: t.name, kind: kind, start: b.units, at: i}
			top := len(stack) - 1
			preParent := top >= 0 && stack[top].kind == appv1.EntityType_ENTITY_TYPE_PRE && stack[top].start == b.units &&
				kind == appv1.EntityType_ENTITY_TYPE_CODE
			if inCode() && !preParent {
				return "", nil, errAt(i, "no tag may open inside <code> or <pre>")
			}
			if err := o.attributes(t, opts, i); err != nil {
				return "", nil, err
			}
			if preParent {
				o.codeInPre = true
				if o.lang != "" {
					stack[top].lang = o.lang
				}
			}
			for _, open := range stack {
				if open.kind == kind && !o.codeInPre {
					return "", nil, errAt(i, "<%s> cannot open inside the same formatting", t.name)
				}
			}
			if len(stack) >= maxNesting {
				return "", nil, errAt(i, "formatting is nested too deeply")
			}
			stack = append(stack, o)
			i += n
		case '>':
			return "", nil, errAt(i, "write > as &gt;")
		default:
			r, size := utf8.DecodeRuneInString(src[i:])
			b.writeRune(r)
			i += size
		}
	}
	if len(stack) > 0 {
		return "", nil, errAt(stack[len(stack)-1].at, "<%s> is not closed", stack[len(stack)-1].name)
	}
	return b.text.String(), b.ents, nil
}

// attributes checks the attributes of an opening tag.
func (o *htmlOpen) attributes(t tag, opts Options, at int) error {
	for name, value := range t.attrs {
		switch {
		case o.name == "a" && name == "href":
			if err := checkURL(at, value, opts); err != nil {
				return err
			}
			o.url = value
		case o.name == "span" && name == "class" && value == "spoiler":
		case o.name == "code" && name == "class" && strings.HasPrefix(value, "language-"):
			lang := strings.TrimPrefix(value, "language-")
			if !validLanguage(lang) {
				return errAt(at, "invalid code language")
			}
			o.lang = lang
		default:
			return errAt(at, "unsupported attribute %s on <%s>", name, o.name)
		}
	}
	switch {
	case o.name == "a" && o.url == "":
		return errAt(at, "<a> needs href")
	case o.name == "span" && t.attrs["class"] != "spoiler":
		return errAt(at, `only <span class="spoiler"> is supported`)
	}
	return nil
}

// ampersand reads the '&' at the start of s as browsers do: a known
// character reference decodes, and an '&' that cannot read as a reference
// ("AT&T", "a & b") is itself. Text shaped like a reference that is not one
// we know ("&nbsp;", "&#0;") is refused rather than guessed.
func ampersand(s string) (rune, int, bool) {
	if r, n, ok := charRef(s); ok {
		return r, n, true
	}
	if looksLikeRef(s) {
		return 0, 0, false
	}
	return '&', 1, true
}

// looksLikeRef reports whether s starts with "&" followed by letters,
// digits or '#' and a ';'.
func looksLikeRef(s string) bool {
	j := 1
	for j < len(s) && j <= 32 && isRefChar(s[j]) {
		j++
	}
	return j > 1 && j < len(s) && s[j] == ';'
}

func isRefChar(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '#'
}

// charRef decodes the character reference at the start of s and returns
// the rune and its length.
func charRef(s string) (rune, int, bool) {
	end := strings.IndexByte(s, ';')
	if end < 2 || end > 10 {
		return 0, 0, false
	}
	name := s[1:end]
	if r, ok := namedRefs[name]; ok {
		return r, end + 1, true
	}
	if name[0] != '#' {
		return 0, 0, false
	}
	var v uint64
	var err error
	if len(name) > 1 && (name[1] == 'x' || name[1] == 'X') {
		v, err = strconv.ParseUint(name[2:], 16, 32)
	} else {
		v, err = strconv.ParseUint(name[1:], 10, 32)
	}
	r := rune(v)
	if err != nil || v == 0 || !utf8.ValidRune(r) {
		return 0, 0, false
	}
	return r, end + 1, true
}

type tag struct {
	name    string
	closing bool
	attrs   map[string]string
}

// readTag reads the tag at src[i] ('<') and returns it with its length.
func readTag(src string, i int) (tag, int, error) {
	end := strings.IndexByte(src[i:], '>')
	if end < 0 {
		return tag{}, 0, errAt(i, "write < as &lt;")
	}
	body := src[i+1 : i+end]
	t := tag{attrs: map[string]string{}}
	if strings.HasPrefix(body, "/") {
		t.closing = true
		body = body[1:]
	}
	j := 0
	for j < len(body) && isNameChar(body[j]) {
		j++
	}
	if j == 0 {
		return tag{}, 0, errAt(i, "write < as &lt;")
	}
	t.name = strings.ToLower(body[:j])
	rest := body[j:]
	for {
		rest = strings.TrimLeft(rest, " \t\n")
		if rest == "" {
			break
		}
		if t.closing {
			return tag{}, 0, errAt(i, "a closing tag has no attributes")
		}
		k := 0
		for k < len(rest) && isNameChar(rest[k]) {
			k++
		}
		if k == 0 {
			return tag{}, 0, errAt(i, "malformed tag")
		}
		name := strings.ToLower(rest[:k])
		rest = strings.TrimLeft(rest[k:], " \t\n")
		if !strings.HasPrefix(rest, "=") {
			return tag{}, 0, errAt(i, "attribute %s needs a value", name)
		}
		rest = strings.TrimLeft(rest[1:], " \t\n")
		var raw string
		switch {
		case strings.HasPrefix(rest, `"`) || strings.HasPrefix(rest, `'`):
			q := rest[0]
			endQuote := strings.IndexByte(rest[1:], q)
			if endQuote < 0 {
				return tag{}, 0, errAt(i, "attribute %s is not closed", name)
			}
			raw, rest = rest[1:1+endQuote], rest[2+endQuote:]
		default:
			k = 0
			for k < len(rest) && rest[k] != ' ' && rest[k] != '\t' && rest[k] != '\n' {
				k++
			}
			raw, rest = rest[:k], rest[k:]
		}
		if _, dup := t.attrs[name]; dup {
			return tag{}, 0, errAt(i, "attribute %s is repeated", name)
		}
		value, err := decodeRefs(raw, i)
		if err != nil {
			return tag{}, 0, err
		}
		t.attrs[name] = value
	}
	return t, end + 1, nil
}

func decodeRefs(s string, at int) (string, error) {
	if !strings.Contains(s, "&") {
		return s, nil
	}
	var out strings.Builder
	for i := 0; i < len(s); {
		if s[i] != '&' {
			out.WriteByte(s[i])
			i++
			continue
		}
		r, n, ok := ampersand(s[i:])
		if !ok {
			return "", errAt(at, "unknown character reference in an attribute")
		}
		out.WriteRune(r)
		i += n
	}
	return out.String(), nil
}

func isNameChar(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-'
}
