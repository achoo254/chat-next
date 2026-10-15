package format

import (
	"strings"
	"unicode/utf8"

	appv1 "app.local/server/gen/app/v1"
)

// Markdown markers (spec/bot-api/format.md):
//
//	*bold*  _italic_  __underline__  ~strike~  ||spoiler||
//	`code`  ```lang\npre```  [text](url)  \ escapes the next character
//
// Formatting nests (a link may hold formatting) but never overlaps, and the
// same marker cannot open inside itself. Inside code and code blocks only
// ` and \ are special.

type mdOpen struct {
	kind  appv1.EntityType
	start int // UTF-16 offset in the output
	at    int // byte offset in the source, for errors
}

// Markdown parses src in the Markdown subset.
func Markdown(src string, opts Options) (string, []*appv1.MessageEntity, error) {
	if err := checkSource(src); err != nil {
		return "", nil, err
	}
	b := &builder{}
	var stack []mdOpen
	toggle := func(kind appv1.EntityType, at int) error {
		if n := len(stack); n > 0 && stack[n-1].kind == kind {
			b.entity(kind, stack[n-1].start)
			stack = stack[:n-1]
			return nil
		}
		for _, o := range stack {
			if o.kind == kind {
				return errAt(at, "formatting markers overlap; close the inner one first")
			}
		}
		if len(stack) >= maxNesting {
			return errAt(at, "formatting is nested too deeply")
		}
		stack = append(stack, mdOpen{kind: kind, start: b.units, at: at})
		return nil
	}
	for i := 0; i < len(src); {
		c := src[i]
		switch {
		case c == '\\':
			if i+1 >= len(src) {
				b.writeRune('\\')
				i++
				continue
			}
			r, size := utf8.DecodeRuneInString(src[i+1:])
			b.writeRune(r)
			i += 1 + size
		case strings.HasPrefix(src[i:], "```"):
			n, err := mdPre(b, src, i)
			if err != nil {
				return "", nil, err
			}
			i = n
		case c == '`':
			n, err := mdCode(b, src, i)
			if err != nil {
				return "", nil, err
			}
			i = n
		case c == '*':
			if err := toggle(appv1.EntityType_ENTITY_TYPE_BOLD, i); err != nil {
				return "", nil, err
			}
			i++
		case strings.HasPrefix(src[i:], "__"):
			if err := toggle(appv1.EntityType_ENTITY_TYPE_UNDERLINE, i); err != nil {
				return "", nil, err
			}
			i += 2
		case c == '_':
			if err := toggle(appv1.EntityType_ENTITY_TYPE_ITALIC, i); err != nil {
				return "", nil, err
			}
			i++
		case c == '~':
			if err := toggle(appv1.EntityType_ENTITY_TYPE_STRIKE, i); err != nil {
				return "", nil, err
			}
			i++
		case strings.HasPrefix(src[i:], "||"):
			if err := toggle(appv1.EntityType_ENTITY_TYPE_SPOILER, i); err != nil {
				return "", nil, err
			}
			i += 2
		case c == '[':
			for _, o := range stack {
				if o.kind == appv1.EntityType_ENTITY_TYPE_TEXT_LINK {
					return "", nil, errAt(i, "a link cannot contain another link")
				}
			}
			if len(stack) >= maxNesting {
				return "", nil, errAt(i, "formatting is nested too deeply")
			}
			stack = append(stack, mdOpen{kind: appv1.EntityType_ENTITY_TYPE_TEXT_LINK, start: b.units, at: i})
			i++
		case c == ']' && len(stack) > 0 && stack[len(stack)-1].kind == appv1.EntityType_ENTITY_TYPE_TEXT_LINK:
			if i+1 >= len(src) || src[i+1] != '(' {
				return "", nil, errAt(i, "a link text must be followed by (url)")
			}
			url, n, err := mdURL(src, i+2)
			if err != nil {
				return "", nil, err
			}
			if err := checkURL(i+2, url, opts); err != nil {
				return "", nil, err
			}
			open := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if e := b.entity(appv1.EntityType_ENTITY_TYPE_TEXT_LINK, open.start); e != nil {
				e.Url = url
			} else {
				return "", nil, errAt(open.at, "a link needs text")
			}
			i = n
		default:
			r, size := utf8.DecodeRuneInString(src[i:])
			b.writeRune(r)
			i += size
		}
	}
	if len(stack) > 0 {
		return "", nil, errAt(stack[len(stack)-1].at, "formatting marker is not closed")
	}
	return b.text.String(), b.ents, nil
}

// mdURL reads a link URL up to the closing parenthesis (\) and \\ escape)
// and returns it with the offset after the parenthesis.
func mdURL(src string, i int) (string, int, error) {
	start := i
	var url strings.Builder
	for i < len(src) {
		switch c := src[i]; {
		case c == '\\' && i+1 < len(src) && (src[i+1] == ')' || src[i+1] == '\\'):
			url.WriteByte(src[i+1])
			i += 2
		case c == ')':
			return url.String(), i + 1, nil
		default:
			url.WriteByte(c)
			i++
		}
	}
	return "", 0, errAt(start, "link URL is not closed with )")
}

// mdCode reads `code` at src[i] (a single backtick).
func mdCode(b *builder, src string, i int) (int, error) {
	start := b.units
	for j := i + 1; j < len(src); {
		switch c := src[j]; {
		case c == '\\' && j+1 < len(src) && (src[j+1] == '`' || src[j+1] == '\\'):
			b.writeRune(rune(src[j+1]))
			j += 2
		case c == '`':
			b.entity(appv1.EntityType_ENTITY_TYPE_CODE, start)
			return j + 1, nil
		default:
			r, size := utf8.DecodeRuneInString(src[j:])
			b.writeRune(r)
			j += size
		}
	}
	return 0, errAt(i, "code is not closed with `")
}

// mdPre reads ```[lang]\n...``` at src[i]. A first line that is a valid
// language name followed by a newline is the language; otherwise the block
// starts right after the opening backticks.
func mdPre(b *builder, src string, i int) (int, error) {
	j := i + 3
	lang := ""
	if nl := strings.IndexByte(src[j:], '\n'); nl > 0 && validLanguage(src[j:j+nl]) {
		lang = src[j : j+nl]
		j += nl + 1
	} else if nl == 0 {
		j++
	}
	start := b.units
	for j < len(src) {
		switch {
		case strings.HasPrefix(src[j:], "```"):
			if e := b.entity(appv1.EntityType_ENTITY_TYPE_PRE, start); e != nil {
				e.Language = lang
			}
			return j + 3, nil
		case src[j] == '\\' && j+1 < len(src) && (src[j+1] == '`' || src[j+1] == '\\'):
			b.writeRune(rune(src[j+1]))
			j += 2
		default:
			r, size := utf8.DecodeRuneInString(src[j:])
			b.writeRune(r)
			j += size
		}
	}
	return 0, errAt(i, "code block is not closed with ```")
}
