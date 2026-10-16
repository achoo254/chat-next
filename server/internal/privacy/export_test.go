package privacy

import (
	"bytes"
	"testing"
	"time"
)

func TestDownloadTokens(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	s := newSigner(bytes.Repeat([]byte{7}, 32))
	g := downloadGrant{tenant: "primary", exportID: 42, userID: 1 << 40, expires: now.Add(urlTTL)}
	token := s.token(g)
	got, err := s.open(token, now)
	if err != nil || got.tenant != g.tenant || got.exportID != g.exportID || got.userID != g.userID || !got.expires.Equal(g.expires) {
		t.Fatalf("open = %+v, %v", got, err)
	}
	if _, err := s.open(token, now.Add(urlTTL)); err == nil {
		t.Fatal("an expired token opened")
	}
	other := newSigner(bytes.Repeat([]byte{8}, 32))
	if _, err := other.open(token, now); err == nil {
		t.Fatal("a token of another key opened")
	}
	for _, bad := range []string{"", "x", token[:len(token)-2] + "AA", token + "A", "!!!!"} {
		if _, err := s.open(bad, now); err == nil {
			t.Fatalf("token %q opened", bad)
		}
	}
}

func TestSafeName(t *testing.T) {
	for in, want := range map[string]string{
		"Ảnh nhà.jpg":        "Ảnh_nhà.jpg",
		"../../etc/passwd":   "etcpasswd",
		".hidden":            "hidden",
		"a/b\\c:d*e?.txt":    "abcde.txt",
		"<script>.html":      "script.html",
		"":                   "",
		"báo cáo (cuối).pdf": "báo_cáo_cuối.pdf",
	} {
		if got := safeName(in); got != want {
			t.Errorf("safeName(%q) = %q, want %q", in, got, want)
		}
	}
	if got := safeName(string(bytes.Repeat([]byte("a"), 200))); len(got) != 80 {
		t.Errorf("long name kept %d runes", len(got))
	}
}
