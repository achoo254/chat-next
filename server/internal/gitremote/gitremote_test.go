package gitremote

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type vector struct {
	Input string  `json:"input"`
	Key   *string `json:"key"`
	Note  string  `json:"note"`
}

func loadVectors(t *testing.T) []vector {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "spec", "git-remote", "test-vectors.json"))
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var vectors []vector
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatalf("decode vectors: %v", err)
	}
	if len(vectors) < 30 {
		t.Fatalf("expected at least 30 vectors, got %d", len(vectors))
	}
	return vectors
}

func TestSharedVectors(t *testing.T) {
	for _, v := range loadVectors(t) {
		got, ok := Canonical(v.Input)
		switch {
		case v.Key == nil && ok:
			t.Errorf("%s: Canonical(%q) = %q, want no key", v.Note, v.Input, got)
		case v.Key != nil && (!ok || got != *v.Key):
			t.Errorf("%s: Canonical(%q) = %q, %v; want %q", v.Note, v.Input, got, ok, *v.Key)
		}
	}
}

func TestSameRepositoryOneKey(t *testing.T) {
	forms := []string{
		"git@github.com:Achoo254/Chat-Next.git",
		"https://github.com/achoo254/chat-next",
		"ssh://git@github.com:22/achoo254/chat-next.git/",
		"https://x:secret@GITHUB.com/achoo254/chat-next.git",
	}
	want, ok := Canonical(forms[0])
	if !ok {
		t.Fatal("no key for the first form")
	}
	for _, f := range forms[1:] {
		if got, _ := Canonical(f); got != want {
			t.Errorf("Canonical(%q) = %q, want %q", f, got, want)
		}
	}
}

func TestBounds(t *testing.T) {
	long := "https://github.com/" + strings.Repeat("a", MaxURLLen)
	if _, ok := Canonical(long); ok {
		t.Error("a URL over MaxURLLen has a key")
	}
	longKey := "https://github.com/" + strings.Repeat("a", MaxKeyLen)
	if _, ok := Canonical(longKey); ok {
		t.Error("a key over MaxKeyLen is accepted")
	}
	if _, ok := Canonical("https://github.com/a/\xff"); ok {
		t.Error("invalid UTF-8 has a key")
	}
}
