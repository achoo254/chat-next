package auth

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

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

func TestTruncate(t *testing.T) {
	cases := []struct {
		in   string
		n    int
		want string
	}{
		{"short", 10, "short"},
		{"abcdef", 3, "abc"},
		{"ab\xffcd", 10, "ab�cd"},
		{"a\x00b", 10, "ab"},
		{"aữb", 2, "a"}, // ữ is 3 bytes: never split
		{"aữb", 4, "aữ"},
		{"\xff\xfe", 3, "�"},
	}
	for _, c := range cases {
		got := truncate(c.in, c.n)
		if got != c.want || !utf8.ValidString(got) || len(got) > c.n {
			t.Errorf("truncate(%q, %d) = %q, want %q", c.in, c.n, got, c.want)
		}
	}
}

func TestCleanReturnTo(t *testing.T) {
	for _, ok := range []string{
		"/", "/chat/123", "/join/abc?x=1&y=2", "/chat/1#msg-5", "/%2F%2Fevil.com", "/tìm-kiếm",
		"/" + strings.Repeat("a", returnToMax-1),
	} {
		if got := CleanReturnTo(ok); got != ok {
			t.Errorf("CleanReturnTo(%q) = %q, want it kept", ok, got)
		}
	}
	for _, bad := range []string{
		"", "//evil.com", "///evil.com", "/\\evil.com", "\\\\evil.com", "/\\/evil.com",
		"https://evil.com", "http:/evil.com", "javascript:alert(1)", "evil.com", "chat/1",
		"/\t/evil.com", "/\n/evil.com", "/\r\n/evil.com", "/ /evil.com", "/ /evil.com", "/\x7f",
		"/a\x00b", "/auth/login", "/auth", "/AUTH/logout", "/" + strings.Repeat("a", returnToMax),
		"/\xff\xfe",
	} {
		if got := CleanReturnTo(bad); got != "" {
			t.Errorf("CleanReturnTo(%q) = %q, want it refused", bad, got)
		}
	}
}

func TestInterstitialAndRetryCarryReturnTo(t *testing.T) {
	w := httptest.NewRecorder()
	writeInterstitial(w, "vi", "/chat/7?topic=2&x=1")
	body := w.Body.String()
	if !strings.Contains(body, `content="0;url=/chat/7?topic=2&amp;x=1"`) || !strings.Contains(body, `href="/chat/7?topic=2&amp;x=1"`) {
		t.Fatalf("interstitial = %s", body)
	}
	w = httptest.NewRecorder()
	writeInterstitial(w, "", "")
	if !strings.Contains(w.Body.String(), `content="0;url=/"`) {
		t.Fatalf("interstitial without return_to = %s", w.Body.String())
	}
	w = httptest.NewRecorder()
	writeErrorPage(w, http.StatusBadRequest, msgSignInFailed, "vi", "/chat/7")
	if !strings.Contains(w.Body.String(), `href="/auth/login?locale=vi&amp;return_to=%2Fchat%2F7"`) {
		t.Fatalf("error page = %s", w.Body.String())
	}
}

// The pages speak the language the sign-in started with, Vietnamese when
// it named none.
func TestPagesSpeakTheSignInLanguage(t *testing.T) {
	for _, c := range []struct {
		lang, html, title, message, retry string
	}{
		{"zh-CN", `<html lang="zh-CN">`, "登录失败", "登录服务器暂时没有响应", "重试"},
		{"en", `<html lang="en">`, "Sign-in failed", "The sign-in server is not responding", "Try again"},
		{"", `<html lang="vi">`, "Đăng nhập không thành công", "Máy chủ đăng nhập đang tạm thời không phản hồi", "Thử lại"},
	} {
		w := httptest.NewRecorder()
		writeErrorPage(w, http.StatusServiceUnavailable, msgIdPUnavailable, c.lang, "/")
		body := w.Body.String()
		for _, want := range []string{c.html, "<title>" + c.title + "</title>", c.message, ">" + c.retry + "</a>"} {
			if !strings.Contains(body, want) {
				t.Errorf("%q error page lacks %q: %s", c.lang, want, body)
			}
		}
	}
	w := httptest.NewRecorder()
	writeInterstitial(w, "zh-CN", "/")
	if body := w.Body.String(); !strings.Contains(body, `<html lang="zh-CN">`) || !strings.Contains(body, "正在登录…") || !strings.Contains(body, ">继续</a>") {
		t.Fatalf("interstitial in Chinese = %s", body)
	}
}

func TestPagesLinkTheAppFavicon(t *testing.T) {
	interstitial := httptest.NewRecorder()
	writeInterstitial(interstitial, "vi", "/")
	failure := httptest.NewRecorder()
	writeErrorPage(failure, http.StatusBadRequest, msgSignInFailed, "vi", "/")
	for name, w := range map[string]*httptest.ResponseRecorder{"interstitial": interstitial, "error": failure} {
		body := w.Body.String()
		for _, link := range []string{`<link rel="icon" href="/favicon.ico"`, `<link rel="icon" href="/icon.svg" type="image/svg+xml">`, `<link rel="apple-touch-icon" href="/apple-touch-icon.png">`} {
			if !strings.Contains(body, link) {
				t.Errorf("%s page lacks %s", name, link)
			}
		}
		if csp := w.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "img-src 'self'") || !strings.Contains(csp, "default-src 'none'") {
			t.Errorf("%s page CSP = %q", name, csp)
		}
	}
}
