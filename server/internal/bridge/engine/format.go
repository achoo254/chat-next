package engine

import (
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/bridge"
)

// entityTypes maps the normalised kinds of an adapter to Chat's. A kind not
// listed (a bot command, a custom emoji, anything new) is dropped: the text
// stays, only its styling is lost.
var entityTypes = map[string]appv1.EntityType{
	"bold":      appv1.EntityType_ENTITY_TYPE_BOLD,
	"italic":    appv1.EntityType_ENTITY_TYPE_ITALIC,
	"underline": appv1.EntityType_ENTITY_TYPE_UNDERLINE,
	"strike":    appv1.EntityType_ENTITY_TYPE_STRIKE,
	"spoiler":   appv1.EntityType_ENTITY_TYPE_SPOILER,
	"code":      appv1.EntityType_ENTITY_TYPE_CODE,
	"pre":       appv1.EntityType_ENTITY_TYPE_PRE,
	"link":      appv1.EntityType_ENTITY_TYPE_TEXT_LINK,
	"url":       appv1.EntityType_ENTITY_TYPE_URL,
	"email":     appv1.EntityType_ENTITY_TYPE_EMAIL,
	"hashtag":   appv1.EntityType_ENTITY_TYPE_HASHTAG,
	"mention":   appv1.EntityType_ENTITY_TYPE_MENTION_NAME,
}

// linkSchemes are the schemes of a hidden link kept as a link; others (a
// Telegram deep link, javascript:) are dropped.
var linkSchemes = []string{"http://", "https://", "mailto:"}

// mapContent turns the text and entities of another app into what Chat
// stores: valid UTF-8 without NUL, cut to maxChars characters with the
// entities cut to match, only kinds Chat knows, links with a safe scheme,
// and mentions pointing at the Chat user of the person mentioned. user maps
// an adapter participant id to that user; a mention of someone it does not
// know is dropped (never a lookup by @username, which could name a real
// person of this system).
func mapContent(text string, ents []bridge.Entity, maxChars int, user func(participantID string) (int64, bool)) (string, []*appv1.MessageEntity) {
	text = strings.ToValidUTF8(text, "")
	text = strings.ReplaceAll(text, "\x00", "")
	cutUnits := -1
	if utf8.RuneCountInString(text) > maxChars {
		prefix := string([]rune(text)[:maxChars])
		cutUnits = len(utf16.Encode([]rune(prefix)))
		text = prefix
	}
	out := make([]*appv1.MessageEntity, 0, len(ents))
	for _, e := range ents {
		typ, ok := entityTypes[e.Kind]
		if !ok || e.Offset < 0 || e.Length <= 0 {
			continue
		}
		length := e.Length
		if cutUnits >= 0 {
			if e.Offset >= cutUnits {
				continue
			}
			length = min(length, cutUnits-e.Offset)
		}
		me := &appv1.MessageEntity{Type: typ, Offset: int32(e.Offset), Length: int32(length)}
		switch typ {
		case appv1.EntityType_ENTITY_TYPE_TEXT_LINK:
			if !hasAnyPrefix(strings.ToLower(e.URL), linkSchemes) {
				continue
			}
			me.Url = e.URL
		case appv1.EntityType_ENTITY_TYPE_MENTION_NAME:
			id, known := user(e.Mention)
			if !known {
				continue
			}
			me.UserId = id
		default:
		}
		out = append(out, me)
	}
	return text, out
}

func hasAnyPrefix(s string, prefixes []string) bool {
	for _, p := range prefixes {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return false
}
