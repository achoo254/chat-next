package auth

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"app.local/server/internal/sealbox"
)

func TestOrigins(t *testing.T) {
	o := NewOrigins("https://chat.hoandat.com/", "http://localhost:5173")
	for origin, want := range map[string]bool{
		"https://chat.hoandat.com": true,
		"HTTPS://Chat.Hoandat.com": true,
		"http://localhost:5173":    true,
		"http://localhost:5174":    false,
		"https://hoandat.com":      false,
		"null":                     false,
		"":                         false,
	} {
		if got := o.Allowed(origin); got != want {
			t.Errorf("Allowed(%q) = %v", origin, got)
		}
	}
}

func TestClientIP(t *testing.T) {
	h := http.Header{}
	h.Set("X-Real-IP", "203.0.113.9")
	cases := []struct {
		remote string
		header http.Header
		want   string
	}{
		{"127.0.0.1:5000", h, "203.0.113.9"},
		{"[::1]:5000", h, "203.0.113.9"},
		{"198.51.100.2:5000", h, "198.51.100.2"}, // not from the proxy: header ignored
		{"127.0.0.1:5000", http.Header{"X-Real-Ip": {"garbage"}}, "127.0.0.1"},
		{"[::ffff:192.0.2.1]:80", nil, "192.0.2.1"},
		{"bogus", nil, ""},
	}
	for _, c := range cases {
		if got := ClientIP(c.remote, c.header); got != c.want {
			t.Errorf("ClientIP(%q) = %q, want %q", c.remote, got, c.want)
		}
	}
}

func TestHashToken(t *testing.T) {
	tok := newSecret(sessionTokenBytes)
	h1, ok := hashToken(tok)
	if !ok || len(h1) != 32 {
		t.Fatalf("hashToken(valid) = %x, %v", h1, ok)
	}
	if h2, _ := hashToken(tok); !bytes.Equal(h1, h2) {
		t.Fatal("hash not deterministic")
	}
	for _, bad := range []string{"", "short", strings.Repeat("A", 44), tok + "="} {
		if _, ok := hashToken(bad); ok {
			t.Errorf("hashToken(%q) accepted", bad)
		}
	}
}

func TestLoginCookieRoundTrip(t *testing.T) {
	box, err := sealbox.New(bytes.Repeat([]byte{1}, 32), "login cookie")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	st := loginState{State: "s", Nonce: "n", Verifier: "v", Locale: "vi", Expires: now.Add(loginTTL).Unix()}
	rec := httptest.NewRecorder()
	if err := setLoginCookie(rec, box, st); err != nil {
		t.Fatal(err)
	}
	raw := rec.Header().Get("Set-Cookie")
	for _, attr := range []string{LoginCookieName + "=", "Path=/", "Max-Age=600", "HttpOnly", "Secure", "SameSite=Lax"} {
		if !strings.Contains(raw, attr) {
			t.Fatalf("login cookie %q lacks %s", raw, attr)
		}
	}
	req := httptest.NewRequest(http.MethodGet, "/auth/callback", nil)
	req.Header.Set("Cookie", strings.SplitN(raw, ";", 2)[0])

	got, err := readLoginCookie(req, box, now)
	if err != nil || got != st {
		t.Fatalf("readLoginCookie = %+v, %v", got, err)
	}
	if _, err := readLoginCookie(req, box, now.Add(loginTTL+time.Second)); err == nil {
		t.Fatal("expired login state accepted")
	}
	other, _ := sealbox.New(bytes.Repeat([]byte{2}, 32), "login cookie")
	if _, err := readLoginCookie(req, other, now); err == nil {
		t.Fatal("login state sealed with another key accepted")
	}
}
