package zalo

import (
	"encoding/json"
	"net/url"
	"slices"
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

// cardContent shows a card of a type the adapter does not know (Zalo adds kinds of
// cards, such as a bank account card) by what every card names: its title, the line
// under it, its link and its picture. ok is false when it names none of the first two.
func cardContent(content json.RawMessage) (text string, media []bridge.Media, ents []bridge.Entity, ok bool) {
	var card linkCard
	if err := json.Unmarshal(content, &card); err != nil {
		return "", nil, nil, false
	}
	title := oneLine(card.Title, linkTitleMax)
	description := oneLine(card.Description, linkDescriptionMax)
	if title == "" && description == "" {
		return "", nil, nil, false
	}
	var b captionBuilder
	titleEntity := bridge.Entity{}
	if href := strings.TrimSpace(card.Href); len(href) <= linkURLMax {
		if page, err := url.Parse(href); err == nil && (page.Scheme == "http" || page.Scheme == "https") && page.Host != "" {
			titleEntity = bridge.Entity{Kind: "link", URL: href}
		}
	}
	b.line(title, titleEntity, true)
	b.line(description, bridge.Entity{}, false)
	if thumb := strings.TrimSpace(card.Thumb); mediaAllowed(thumb) {
		media = []bridge.Media{{Ref: mediaRef + thumb, Kind: "photo"}}
	}
	return b.text.String(), media, b.ents, true
}

// contentShape describes the content of a message without anything it says: the
// names of its fields, of the fields of its params and its action, so the log of a
// message type not yet supported shows how to support it.
func contentShape(content json.RawMessage) (fields, params []string, action string) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(content, &obj); err != nil {
		return nil, nil, ""
	}
	fields = fieldNames(obj)
	var raw string
	if json.Unmarshal(obj["action"], &raw) == nil && codeWord.MatchString(strings.ReplaceAll(raw, ".", "_")) {
		action = raw
	}
	paramsRaw := obj["params"]
	if json.Unmarshal(paramsRaw, &raw) == nil {
		paramsRaw = json.RawMessage(raw)
	}
	var p map[string]json.RawMessage
	if json.Unmarshal(paramsRaw, &p) == nil {
		params = fieldNames(p)
	}
	return fields, params, action
}

// fieldNames are the names of an object's fields that read like field names (at
// most 40), sorted: a name that could carry a value, such as a number, is left out.
func fieldNames(obj map[string]json.RawMessage) []string {
	names := make([]string, 0, len(obj))
	for k := range obj {
		if codeWord.MatchString(k) && strings.Trim(k, "0123456789") != "" {
			names = append(names, k)
		}
	}
	slices.Sort(names)
	return names[:min(len(names), 40)]
}
