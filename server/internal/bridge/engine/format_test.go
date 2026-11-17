package engine

import (
	"strings"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/bridge"
)

func TestMapContentDegrades(t *testing.T) {
	known := func(id string) (int64, bool) { return 77, id == "p1" }
	text, ents := mapContent("a\x00b \xff chào", []bridge.Entity{
		{Kind: "bold", Offset: 0, Length: 1},
		{Kind: "link", Offset: 0, Length: 1, URL: "tg://resolve?domain=x"},
		{Kind: "link", Offset: 0, Length: 1, URL: "HTTPS://example.com"},
		{Kind: "mention", Offset: 2, Length: 2, Mention: "p1"},
		{Kind: "mention", Offset: 2, Length: 2, Mention: "stranger"},
		{Kind: "bot_command", Offset: 0, Length: 1},
		{Kind: "bold", Offset: -1, Length: 3},
	}, 100, known)
	if text != "ab  chào" {
		t.Fatalf("text = %q", text)
	}
	var kinds []appv1.EntityType
	for _, e := range ents {
		kinds = append(kinds, e.GetType())
	}
	want := []appv1.EntityType{appv1.EntityType_ENTITY_TYPE_BOLD, appv1.EntityType_ENTITY_TYPE_TEXT_LINK, appv1.EntityType_ENTITY_TYPE_MENTION_NAME}
	if len(kinds) != len(want) {
		t.Fatalf("kinds = %v, want %v (tg:// link, unknown mention, command and bad range dropped)", kinds, want)
	}
	for i := range want {
		if kinds[i] != want[i] {
			t.Fatalf("kinds = %v, want %v", kinds, want)
		}
	}
	if ents[2].GetUserId() != 77 {
		t.Fatalf("mention user = %d", ents[2].GetUserId())
	}
}

func TestMapContentCutsLongTextAndItsEntities(t *testing.T) {
	text, ents := mapContent(strings.Repeat("x", 50), []bridge.Entity{
		{Kind: "bold", Offset: 5, Length: 10},
		{Kind: "bold", Offset: 8, Length: 4},
		{Kind: "italic", Offset: 20, Length: 5},
	}, 10, func(string) (int64, bool) { return 0, false })
	if len([]rune(text)) != 10 {
		t.Fatalf("text has %d characters, want 10", len([]rune(text)))
	}
	if len(ents) != 2 || ents[0].GetLength() != 5 || ents[1].GetOffset() != 8 || ents[1].GetLength() != 2 {
		t.Fatalf("entities = %v, want the two inside the cut, clipped to it", ents)
	}
}
