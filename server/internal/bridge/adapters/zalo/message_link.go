package zalo

import (
	"encoding/json"
	"net/url"
	"strings"
	"unicode/utf16"

	"app.local/server/internal/bridge"
)

// Message types of a shared link. zca-js sends a link as "chat.recommended"
// (the same type as a shared contact card, told apart by the action) and
// names "chat.link" too; a real account showed a Google Maps place shared
// from a phone as a card with a picture, the site, a title and a line under it.
const (
	msgTypeRecommended = "chat.recommended"
	msgTypeLink        = "chat.link"
	actionLink         = "recommened.link" // Zalo's own spelling
)

// Bounds of the parts of a link card copied into the caption, in bytes.
const (
	linkTitleMax       = 512
	linkDescriptionMax = 1024
	linkURLMax         = 2048
)

// linkCard is the part of a link message's content the adapter reads.
type linkCard struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	Href        string `json:"href"`
	Thumb       string `json:"thumb"`
	Action      string `json:"action"`
}

// isLinkMessage reports whether a message of msgType with this content is a shared
// link: a chat.link, or a chat.recommended whose action is a link (not a contact).
func isLinkMessage(msgType string, card linkCard) bool {
	switch msgType {
	case msgTypeLink:
		return true
	case msgTypeRecommended:
		return card.Action == actionLink
	}
	return false
}

// linkContent turns a shared link into what Chat shows for Zalo's card: its picture
// (when it is on Zalo's CDN) with a caption of the site, the title linking to the
// page and the line under it. ok is false when the content is not a usable link.
func linkContent(msgType string, content json.RawMessage) (text string, media []bridge.Media, ents []bridge.Entity, ok bool) {
	var card linkCard
	if err := json.Unmarshal(content, &card); err != nil || !isLinkMessage(msgType, card) {
		return "", nil, nil, false
	}
	href := strings.TrimSpace(card.Href)
	page, err := url.Parse(href)
	if err != nil || len(href) > linkURLMax || (page.Scheme != "http" && page.Scheme != "https") || page.Host == "" {
		return "", nil, nil, false
	}
	var b captionBuilder
	b.line(page.Hostname(), bridge.Entity{Kind: "url"}, false)
	title := oneLine(card.Title, linkTitleMax)
	if title == "" {
		title = href
	}
	b.line(title, bridge.Entity{Kind: "link", URL: href}, true)
	b.line(oneLine(card.Description, linkDescriptionMax), bridge.Entity{}, false)
	thumb := strings.TrimSpace(card.Thumb)
	if mediaAllowed(thumb) {
		media = []bridge.Media{{Ref: mediaRef + thumb, Kind: "photo"}}
	}
	return b.text.String(), media, b.ents, true
}

// captionBuilder writes lines of a caption and the entities over them, offsets in
// UTF-16 code units as Chat counts them.
type captionBuilder struct {
	text  strings.Builder
	units int
	ents  []bridge.Entity
}

// line appends s as a line; a non-empty e.Kind spans it, bold spans it in bold too.
func (b *captionBuilder) line(s string, e bridge.Entity, bold bool) {
	if s == "" {
		return
	}
	if b.units > 0 {
		b.text.WriteString("\n")
		b.units++
	}
	n := len(utf16.Encode([]rune(s)))
	if e.Kind != "" {
		e.Offset, e.Length = b.units, n
		b.ents = append(b.ents, e)
	}
	if bold {
		b.ents = append(b.ents, bridge.Entity{Kind: "bold", Offset: b.units, Length: n})
	}
	b.text.WriteString(s)
	b.units += n
}

// oneLine is s on one line, trimmed and cut to at most max bytes.
func oneLine(s string, max int) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > max {
		s = truncateUTF8(s, max)
	}
	return s
}
