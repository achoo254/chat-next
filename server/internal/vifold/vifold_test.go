package vifold

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

type vector struct {
	Input  string   `json:"input"`
	Fold   string   `json:"fold"`
	Tokens []string `json:"tokens"`
}

func loadVectors(t *testing.T) []vector {
	t.Helper()
	path := filepath.Join("..", "..", "..", "spec", "vi-fold", "test-vectors.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var vectors []vector
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatalf("decode vectors: %v", err)
	}
	if len(vectors) < 300 {
		t.Fatalf("expected at least 300 vectors, got %d", len(vectors))
	}
	return vectors
}

func TestSharedVectors(t *testing.T) {
	for i, v := range loadVectors(t) {
		if got := Fold(v.Input); got != v.Fold {
			t.Errorf("#%d Fold(%q) = %q, want %q", i, v.Input, got, v.Fold)
		}
		if got := Tokens(v.Input); !slices.Equal(got, v.Tokens) {
			t.Errorf("#%d Tokens(%q) = %q, want %q", i, v.Input, got, v.Tokens)
		}
		if got, want := SearchText(v.Input), strings.Join(v.Tokens, " "); got != want {
			t.Errorf("#%d SearchText(%q) = %q, want %q", i, v.Input, got, want)
		}
	}
}

func TestRequiredExamples(t *testing.T) {
	cases := map[string]string{
		"Người đẹp Đà Nẵng": "nguoi dep da nang",
		"Ưu đãi":            "uu dai",
		"Ăn":                "an",
	}
	for input, want := range cases {
		if got := Fold(input); got != want {
			t.Errorf("Fold(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestFoldIsIdempotent(t *testing.T) {
	for _, v := range loadVectors(t) {
		if again := Fold(v.Fold); again != v.Fold {
			t.Errorf("Fold(Fold(%q)) = %q, want %q", v.Input, again, v.Fold)
		}
	}
}

func TestSearchTextDropsTextBetweenTokens(t *testing.T) {
	cases := map[string]string{
		"Giá: 1.250.000₫":      "gia 1.250.000",
		"日本語のテキスト":             "日 本 語 の テキスト",
		"a.b.c. Hello, World!": "a.b.c hello world",
		" 👍🏽 ... ":             "",
	}
	for input, want := range cases {
		if got := SearchText(input); got != want {
			t.Errorf("SearchText(%q) = %q, want %q", input, got, want)
		}
	}
}
