package main

import "testing"

// The SDKs' generated files follow the spec: changing the spec without
// running `go run ./cmd/sdkgen` (from server/) fails here.
func TestGeneratedFilesUpToDate(t *testing.T) {
	dir, err := root()
	if err != nil {
		t.Fatal(err)
	}
	names, err := stale(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(names) > 0 {
		t.Fatalf("out of date, run `go run ./cmd/sdkgen` in server/: %v", names)
	}
}

func TestNames(t *testing.T) {
	for in, want := range map[string]string{"chat_id": "ChatID", "user_ids": "UserIDs", "url_expires": "URLExpires", "html": "HTML", "inlineQueryId": "InlineQueryID"} {
		if got := goName(in); got != want {
			t.Errorf("goName(%q) = %q, want %q", in, got, want)
		}
	}
	for in, want := range map[string]string{"bulk_id": "bulkID", "inline_query_id": "inlineQueryID", "id": "id"} {
		if got := goVar(in); got != want {
			t.Errorf("goVar(%q) = %q, want %q", in, got, want)
		}
	}
	if got := snake("answerInlineQuery"); got != "answer_inline_query" {
		t.Errorf("snake = %q", got)
	}
}
