package search

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
)

type vector struct {
	Input  string   `json:"input"`
	Tokens []string `json:"tokens"`
}

// The indexed text of every shared vector (spec/vi-fold) is its tokens, and
// the query of the same input finds it through the word patterns.
func TestFieldsFollowSharedVectors(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "spec", "vi-fold", "test-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors []vector
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	if len(vectors) < 300 {
		t.Fatalf("only %d vectors", len(vectors))
	}
	for i, v := range vectors {
		f := FieldsOf("group", v.Input, nil)
		if want := strings.Join(v.Tokens, " "); f.Lexemes != want || f.Text != want {
			t.Errorf("#%d FieldsOf(%q) = %q / %q, want %q", i, v.Input, f.Text, f.Lexemes, want)
			continue
		}
		q, err := parseQuery(v.Input)
		if err != nil {
			if len(v.Tokens) > TokensMax {
				continue
			}
			t.Fatalf("#%d parseQuery(%q): %v", i, v.Input, err)
		}
		if !matches(f, q) {
			t.Errorf("#%d query %q does not find its own text %q", i, v.Input, f.Text)
		}
	}
}

// matches evaluates the condition of fetch in Go: every token inside the
// search text, or for a query of short tokens only, the tsquery.
func matches(f Fields, q query) bool {
	if !q.substring {
		return matchesLexemes(f.Lexemes, q.tokens)
	}
	for _, tok := range q.tokens {
		if !strings.Contains(f.Text, tok) {
			return false
		}
	}
	return true
}

// matchesLexemes evaluates the tsquery of fetch in Go: every token a
// lexeme, the last a prefix of one.
func matchesLexemes(lexemes string, tokens []string) bool {
	words := strings.Split(lexemes, " ")
	for i, tok := range tokens {
		found := false
		for _, w := range words {
			if w == tok || (i == len(tokens)-1 && strings.HasPrefix(w, tok)) {
				found = true
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func TestFieldsOf(t *testing.T) {
	photo := &appv1.Message{Media: &appv1.MediaRef{Kind: appv1.MediaKind_MEDIA_KIND_DOCUMENT, FileName: "Thiết-kế_màn-v2.fig"}}
	cases := []struct {
		name     string
		chatType string
		text     string
		content  *appv1.Message
		want     Fields
	}{
		{"text", "group", "Người đẹp Đà Nẵng", nil, Fields{Text: "nguoi dep da nang", Lexemes: "nguoi dep da nang"}},
		{"caption and file name", "private", "Bản cuối", photo, Fields{Text: "ban cuoi thiet ke_man v2 fig", Lexemes: "ban cuoi thiet ke_man v2 fig", MediaKind: 5}},
		{"file without caption", "group", "", photo, Fields{Text: "thiet ke_man v2 fig", Lexemes: "thiet ke_man v2 fig", MediaKind: 5}},
		{"service message", "group", "", &appv1.Message{Action: &appv1.MessageAction{}}, Fields{}},
		{"secret chat", "secret", "Người đẹp", photo, Fields{}},
		{"bare URL", "group", "xem https://example.test", nil, Fields{Text: "xem https example.test", Lexemes: "xem https example.test", HasLink: true}},
		{"text link", "group", "bấm đây", &appv1.Message{Entities: []*appv1.MessageEntity{{Type: appv1.EntityType_ENTITY_TYPE_TEXT_LINK}}}, Fields{Text: "bam day", Lexemes: "bam day", HasLink: true}},
		{"preview", "group", "trang", &appv1.Message{LinkPreview: &appv1.LinkPreview{}}, Fields{Text: "trang", Lexemes: "trang", HasLink: true}},
		{"emoji only", "group", "👍🏽", nil, Fields{}},
	}
	for _, c := range cases {
		if got := FieldsOf(c.chatType, c.text, c.content); got != c.want {
			t.Errorf("%s: FieldsOf = %+v, want %+v", c.name, got, c.want)
		}
	}
}

func TestLongTokensAreCut(t *testing.T) {
	f := FieldsOf("group", "x "+strings.Repeat("đ", 300), nil)
	if got := strings.Split(f.Lexemes, " ")[1]; len(got) != LexemeMaxBytes {
		t.Fatalf("lexeme of %d bytes", len(got))
	}
	// The search text keeps the whole token, so any part of it is found.
	if f.Text != "x "+strings.Repeat("d", 300) {
		t.Fatalf("search text %q", f.Text)
	}
	cut, wasCut := capLexeme(strings.Repeat("日", 100))
	if !wasCut || len(cut) > LexemeMaxBytes || len(cut)%3 != 0 {
		t.Fatalf("cut %d bytes (%t)", len(cut), wasCut)
	}
}

func TestTSQuery(t *testing.T) {
	cases := map[string]string{
		"nguoi dep":  "'nguoi' & 'dep':*",
		"don't stop": "'don''t' & 'stop':*",
		"1.250.000":  "'1.250.000':*",
	}
	for query, want := range cases {
		q, err := parseQuery(query)
		if err != nil {
			t.Fatal(err)
		}
		if got := tsQuery(q.tokens); got != want {
			t.Errorf("tsQuery(%q) = %s, want %s", query, got, want)
		}
	}
	if got := tsQuery([]string{strings.Repeat("a", 300), "b"}); !strings.HasSuffix(strings.Split(got, " & ")[0], "':*") {
		t.Errorf("a cut token must match as a prefix: %s", got)
	}
}

func TestParseQuery(t *testing.T) {
	q, err := parseQuery("  Đà  NẴNG, đẹp! ")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(q.tokens, " ") != "da nang dep" || strings.Join(q.words, " ") != "đà nẵng đẹp" || !q.accented {
		t.Fatalf("parsed %+v", q)
	}
	if !q.exact("Hẹn ở ĐÀ NẴNG, cảnh đẹp lắm") || q.exact("Da Nang dep") || q.exact("Đà Nẵng thôi") {
		t.Fatal("exact-accent check")
	}
	// Decomposed input ranks like composed input.
	if !q.exact("\u0110a\u0300 N\u1eb5ng \u0111e\u0323p") {
		t.Fatal("decomposed text")
	}
	plain, _ := parseQuery("da nang")
	if plain.accented {
		t.Fatal("plain query marked accented")
	}
	if upper, _ := parseQuery("DA NANG"); upper.accented {
		t.Fatal("upper case is not an accent")
	}
	if _, err := parseQuery(strings.Repeat("a ", TokensMax+1)); !errors.Is(err, ErrInvalid) {
		t.Fatalf("too many words: %v", err)
	}
	if _, err := parseQuery(strings.Repeat("á", QueryMaxRunes+1)); !errors.Is(err, ErrInvalid) {
		t.Fatalf("too long: %v", err)
	}
}

func TestShortTokensMatchWordStarts(t *testing.T) {
	cases := map[string]bool{
		"uần":       true,  // three letters: a substring
		"truc tu":   true,  // one long token makes every token a substring
		"di an":     false, // two short tokens: word starts
		"ng":        false,
		"1.2":       true,  // three characters, whatever they are
		"日本":        false, // two one-character tokens
		"ab cd ef":  false,
		"  ?! ":     false,
		"Đường đi":  true,
		"ĐƯỜNG":     true,
		"a b c abc": true,
	}
	for text, want := range cases {
		q, err := parseQuery(text)
		if err != nil {
			t.Fatal(err)
		}
		if q.substring != want {
			t.Errorf("parseQuery(%q).substring = %t, want %t", text, q.substring, want)
		}
	}
}

func TestMatchCondition(t *testing.T) {
	cases := []struct {
		query string
		sql   string
		args  []any
	}{
		{"", "(length(m.search_tsv) > 0 OR m.media_kind <> 0)", nil},
		{"uần", "m.search_text LIKE $1", []any{"%uan%"}},
		{"truc tu", "m.search_text LIKE $1 AND strpos(m.search_text, $2) > 0", []any{"%truc%", "tu"}},
		{"di an", "m.search_tsv @@ $1::tsquery", []any{"'di' & 'an':*"}},
		// LIKE wildcards in a token are literal.
		{"ke_man 100%", `m.search_text LIKE $1 AND m.search_text LIKE $2`, []any{`%ke\_man%`, "%100%"}},
	}
	for _, c := range cases {
		q, err := parseQuery(c.query)
		if err != nil {
			t.Fatal(err)
		}
		st := &statement{}
		if got := q.match(st); got != c.sql || !slices.Equal(st.args, c.args) {
			t.Errorf("match(%q) = %s %q, want %s %q", c.query, got, st.args, c.sql, c.args)
		}
	}
}

func TestLikeEscaper(t *testing.T) {
	if got := likeEscaper.Replace(`a\b%c_d`); got != `a\\b\%c\_d` {
		t.Fatalf("escaped %s", got)
	}
}

func TestCursorRoundTrip(t *testing.T) {
	at := time.Date(2026, 10, 15, 9, 30, 0, 123456000, time.UTC)
	c := cursor{phase: phaseRest, after: &key{date: at, chatID: 42, seq: 7}, bound: &key{date: at.Add(-time.Hour), chatID: 3, seq: 1}, request: 99}
	got, err := decodeCursor(c.encode(), 99)
	if err != nil {
		t.Fatal(err)
	}
	if got.phase != c.phase || !got.after.date.Equal(at) || got.after.chatID != 42 || got.after.seq != 7 ||
		got.bound.chatID != 3 || !got.bound.date.Equal(at.Add(-time.Hour)) {
		t.Fatalf("round trip = %+v", got)
	}
	empty, err := decodeCursor(cursor{request: 5}.encode(), 5)
	if err != nil || empty.after != nil || empty.bound != nil || empty.phase != phaseExact {
		t.Fatalf("empty cursor = %+v, %v", empty, err)
	}
	for _, bad := range []string{c.encode()[1:], "bm90IGEgY3Vyc29y", strings.Repeat("A", 300)} {
		if _, err := decodeCursor(bad, 99); !errors.Is(err, ErrInvalid) {
			t.Errorf("decode %q: %v", bad, err)
		}
	}
	if _, err := decodeCursor(c.encode(), 100); !errors.Is(err, ErrInvalid) {
		t.Fatalf("other request: %v", err)
	}
}

func TestKeyOrder(t *testing.T) {
	at := time.Unix(1000, 0)
	older := key{date: at.Add(-time.Microsecond), chatID: 9, seq: 9}
	k := key{date: at, chatID: 5, seq: 5}
	if !older.before(k) || k.before(older) {
		t.Fatal("date order")
	}
	if !(key{date: at, chatID: 4, seq: 9}).before(k) || !(key{date: at, chatID: 5, seq: 4}).before(k) || k.before(k) {
		t.Fatal("tie breaks")
	}
}

func TestRequestIDDependsOnTheSearch(t *testing.T) {
	base := Request{TenantID: "t", UserID: 1, Query: "a"}
	variants := []Request{
		{TenantID: "t", UserID: 2, Query: "a"},
		{TenantID: "t", UserID: 1, Query: "b"},
		{TenantID: "t", UserID: 1, Query: "a", ChatID: 3},
		{TenantID: "t", UserID: 1, Query: "a", Order: OrderNewest},
		{TenantID: "t", UserID: 1, Query: "a", Filter: Filter{HasLink: true}},
	}
	for _, v := range variants {
		if requestID(v) == requestID(base) {
			t.Errorf("%+v has the id of %+v", v, base)
		}
	}
	if requestID(Request{TenantID: "t", UserID: 1, Query: " a "}) != requestID(base) {
		t.Error("surrounding spaces change the id")
	}
}
