package search

import (
	"strings"
	"unicode/utf8"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/vifold"
)

// LexemeMaxBytes caps one indexed token: tsvector lexemes may not exceed
// 2 KiB, and a longer token (a long URL) is only ever found by its start.
const LexemeMaxBytes = 255

// Fields are the search columns of a message row, written in the same
// transaction as its content.
type Fields struct {
	// Lexemes are the vifold tokens of the text, caption and file name,
	// each at most LexemeMaxBytes, joined by single spaces (tokens never
	// contain one); "" when the message has nothing searchable. Store them
	// with TSVector.
	Lexemes   string
	MediaKind int16
	HasLink   bool
}

// TSVector is the SQL expression that turns the Lexemes bound to placeholder
// (for example "$12") into the search_tsv value: the tokens as lexemes,
// without the text search parser.
func TSVector(placeholder string) string {
	return "array_to_tsvector(string_to_array(" + placeholder + "::text, ' '))"
}

// FieldsOf returns the search columns of a message of a chat of chatType
// with this text (or caption) and content. Secret chats are never indexed;
// pass content nil and text "" for a message deleted for everyone.
func FieldsOf(chatType, text string, content *appv1.Message) Fields {
	if chatType == "secret" {
		return Fields{}
	}
	source := text
	if name := content.GetMedia().GetFileName(); name != "" {
		source += "\n" + name
	}
	tokens := vifold.Tokens(source)
	for i, t := range tokens {
		tokens[i], _ = capLexeme(t)
	}
	return Fields{
		Lexemes:   strings.Join(tokens, " "),
		MediaKind: int16(content.GetMedia().GetKind()),
		HasLink:   hasLink(text, content),
	}
}

// capLexeme cuts a token to LexemeMaxBytes on a rune boundary and reports
// whether it was cut.
func capLexeme(token string) (string, bool) {
	if len(token) <= LexemeMaxBytes {
		return token, false
	}
	cut := LexemeMaxBytes
	for cut > 0 && !utf8.RuneStart(token[cut]) {
		cut--
	}
	return token[:cut], true
}

func hasLink(text string, content *appv1.Message) bool {
	if content.GetLinkPreview() != nil {
		return true
	}
	for _, e := range content.GetEntities() {
		if t := e.GetType(); t == appv1.EntityType_ENTITY_TYPE_URL || t == appv1.EntityType_ENTITY_TYPE_TEXT_LINK {
			return true
		}
	}
	lowered := strings.ToLower(text)
	return strings.Contains(lowered, "http://") || strings.Contains(lowered, "https://")
}
