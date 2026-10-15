// Package format turns the Bot API's parse_mode text (a Markdown subset and
// an HTML subset, spec/bot-api/format.md) into plain text plus entities
// (ADR 0004: offsets in UTF-16 code units). Parsing is strict: an unclosed
// or mis-nested marker, an unknown tag or a link to a scheme outside the
// allowlist is an error, never a guess.
package format

import (
	"fmt"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/entities"
)

// Options configure a parse.
type Options struct {
	// AppScheme is the app's own URL scheme allowed in links (ADR 0004).
	AppScheme string
}

// Error is a parse failure at a byte offset of the source.
type Error struct {
	Offset int
	Reason string
}

func (e *Error) Error() string {
	return fmt.Sprintf("byte %d: %s", e.Offset, e.Reason)
}

func errAt(offset int, format string, args ...any) error {
	return &Error{Offset: offset, Reason: fmt.Sprintf(format, args...)}
}

// maxNesting bounds nested formatting.
const maxNesting = 16

// languageMax bounds the language of a code block, as the message core does.
const languageMax = 32

// builder writes the plain text and tracks its UTF-16 length.
type builder struct {
	text  strings.Builder
	units int
	ents  []*appv1.MessageEntity
}

func (b *builder) writeRune(r rune) {
	b.text.WriteRune(r)
	b.units += utf16.RuneLen(r)
}

// entity records an entity from start to the current position; an empty
// span is dropped.
func (b *builder) entity(t appv1.EntityType, start int) *appv1.MessageEntity {
	if b.units == start {
		return nil
	}
	e := &appv1.MessageEntity{Type: t, Offset: int32(start), Length: int32(b.units - start)}
	b.ents = append(b.ents, e)
	return e
}

func checkSource(src string) error {
	if !utf8.ValidString(src) {
		return errAt(0, "the text is not valid UTF-8")
	}
	if i := strings.IndexByte(src, 0); i >= 0 {
		return errAt(i, "the text contains a NUL character")
	}
	return nil
}

func checkURL(offset int, url string, opts Options) error {
	if url == "" || !entities.IsAllowedURL(url, opts.AppScheme) {
		return errAt(offset, "link URL is not allowed (http, https, mailto and the app scheme only)")
	}
	return nil
}

func validLanguage(lang string) bool {
	if lang == "" || len(lang) > languageMax {
		return false
	}
	for _, c := range lang {
		letter := c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
		digit := c >= '0' && c <= '9'
		if !letter && !digit && !strings.ContainsRune("_+-#.", c) {
			return false
		}
	}
	return true
}
