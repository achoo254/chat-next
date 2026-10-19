package miniapp

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
)

// The init data vector the SDK tests verify (sdk/ts/test/miniapp.test.ts,
// sdk/python/tests/test_miniapp.py, sdk/go/miniapp_test.go and
// docs/bot-api/README.md): SESSION_KEY of 32 bytes 0x07, tenant primary.
const (
	vectorKey      = "3ktwc67vmU-jLgKZ13Lj1iN6KAk145mjNELp-vwXrcg"
	vectorInitData = "auth_date=1760850000&bot_id=1234567&chat_instance=jkvivnNpwnmKUPzV&chat_type=private" +
		"&signature=_Z0BDYBsfng_LKrIg5NS1OZZMzOmjLKQU9sXDmE4vYMWAzIZzX8_W_XApoETPJsVzHm-pwST8Goq1Z92Vnu0CQ" +
		"&start_param=promo_1&tenant_id=primary" +
		"&user=%7B%22id%22%3A7654321%2C%22first_name%22%3A%22Lan+Nguy%E1%BB%85n%22%2C%22username%22%3A%22lan%22%7D"
	vectorBotID    = 1234567
	vectorAuthDate = 1760850000
)

func vectorSigner(t *testing.T) *Signer {
	t.Helper()
	s, err := NewSigner(bytes.Repeat([]byte{7}, 32), "primary")
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// verify is what a bot does with init data (the SDK helpers): the
// signature over the data check string, the bot id and the age.
func verify(initData string, botID int64, publicKey string, now time.Time) error {
	key, err := base64.RawURLEncoding.DecodeString(publicKey)
	if err != nil || len(key) != ed25519.PublicKeySize {
		return errors.New("bad key")
	}
	q, err := url.ParseQuery(initData)
	if err != nil {
		return err
	}
	signature, err := base64.RawURLEncoding.DecodeString(q.Get("signature"))
	if err != nil {
		return err
	}
	fields := map[string]string{}
	for k, v := range q {
		if k != "signature" {
			fields[k] = v[0]
		}
	}
	if !ed25519.Verify(key, []byte(DataCheckString(botID, fields)), signature) {
		return errors.New("bad signature")
	}
	if fields["bot_id"] != strconv.FormatInt(botID, 10) {
		return errors.New("other bot")
	}
	at, err := strconv.ParseInt(fields["auth_date"], 10, 64)
	if err != nil || now.Sub(time.Unix(at, 0)) > time.Hour {
		return errors.New("expired")
	}
	return nil
}

func TestSignVector(t *testing.T) {
	s := vectorSigner(t)
	if s.PublicKey() != vectorKey {
		t.Fatalf("public key = %s", s.PublicKey())
	}
	got, err := s.Sign(InitData{
		BotID: vectorBotID, User: User{ID: 7654321, FirstName: "Lan Nguyễn", Username: "lan"},
		ChatType: ChatPrivate, ChatInstance: s.ChatInstance(4242, 7654321, vectorBotID), StartParam: "promo_1",
		AuthDate: time.Unix(vectorAuthDate, 0),
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != vectorInitData {
		t.Fatalf("init data changed (update the SDK tests and docs too):\n%s", got)
	}
	at := time.Unix(vectorAuthDate+60, 0)
	if err := verify(got, vectorBotID, vectorKey, at); err != nil {
		t.Fatalf("vector does not verify: %v", err)
	}
	if err := verify(got, vectorBotID+1, vectorKey, at); err == nil {
		t.Fatal("another bot accepted the init data")
	}
	if err := verify(got, vectorBotID, vectorKey, time.Unix(vectorAuthDate+3601, 0)); err == nil {
		t.Fatal("init data older than an hour accepted")
	}
	tampered := strings.Replace(got, "chat_type=private", "chat_type=group", 1)
	if err := verify(tampered, vectorBotID, vectorKey, at); err == nil {
		t.Fatal("tampered init data accepted")
	}
}

func TestSignerKeys(t *testing.T) {
	if _, err := NewSigner(make([]byte, 31), "primary"); err == nil {
		t.Fatal("a short session key was accepted")
	}
	a := vectorSigner(t)
	b, err := NewSigner(bytes.Repeat([]byte{8}, 32), "primary")
	if err != nil {
		t.Fatal(err)
	}
	if a.PublicKey() == b.PublicKey() {
		t.Fatal("another session key gives the same signing key")
	}
	// chat_instance is stable for a chat and bot, differs across chats,
	// bots and (outside a chat) users.
	if a.ChatInstance(10, 1, 5) != a.ChatInstance(10, 2, 5) {
		t.Fatal("chat_instance depends on the user inside a chat")
	}
	seen := map[string]bool{}
	for _, v := range []string{a.ChatInstance(10, 1, 5), a.ChatInstance(11, 1, 5), a.ChatInstance(10, 1, 6),
		a.ChatInstance(0, 1, 5), a.ChatInstance(0, 2, 5)} {
		if seen[v] {
			t.Fatalf("chat_instance %q repeats", v)
		}
		seen[v] = true
	}
	// Without a start parameter the field is left out.
	d, err := a.Sign(InitData{BotID: 5, User: User{ID: 1, FirstName: "A"}, ChatType: ChatSender, ChatInstance: "x",
		AuthDate: time.Unix(vectorAuthDate, 0)})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(d, "start_param") || strings.Contains(d, "username") {
		t.Fatalf("empty fields sent: %s", d)
	}
	if err := verify(d, 5, a.PublicKey(), time.Unix(vectorAuthDate, 0)); err != nil {
		t.Fatal(err)
	}
}

func TestHostRules(t *testing.T) {
	ok := map[string]string{
		"https://app.example.org/":            "app.example.org",
		"https://APP.Example.org:8443/x?y=1":  "app.example.org",
		"https://bücher.de/shop":              "xn--bcher-kva.de",
		"https://miniapp.vercel.app/index":    "miniapp.vercel.app",
		"https://example.co.uk/path/to/app":   "example.co.uk",
		"https://a.b.example.com/?start=true": "a.b.example.com",
	}
	for raw, host := range ok {
		got, err := hostOf(raw)
		if err != nil || got != host {
			t.Errorf("hostOf(%q) = %q, %v; want %q", raw, got, err, host)
		}
	}
	refused := []string{
		"",
		"http://example.org/",
		"ftp://example.org/",
		"javascript:alert(1)",
		"https:example.org",
		"//example.org/",
		"https://user:pass@example.org/",
		"https://user@example.org/",
		"https://example.org/#x",
		"https://example.org/#",
		"https://127.0.0.1/",
		"https://[::1]/",
		"https://10.0.0.1:8443/",
		"https://127.1/",
		"https://0x7f.1/",
		"https://example.123/",
		"https://localhost/",
		"https://intranet/",
		"https://example.org./",
		"https://com/",
		"https://github.io/",
		"https://example.org/" + strings.Repeat("a", URLMax),
	}
	for _, raw := range refused {
		if _, err := hostOf(raw); connect.CodeOf(err) != connect.CodeInvalidArgument ||
			!strings.Contains(err.Error(), "mini_app_url_not_allowed") {
			t.Errorf("hostOf(%q) = %v, want mini_app_url_not_allowed", raw, err)
		}
	}
}

func TestRefusedDomains(t *testing.T) {
	urls, err := NewURLs("https://chat.hoandat.com")
	if err != nil {
		t.Fatal(err)
	}
	if urls.appDomain != "hoandat.com" {
		t.Fatalf("app domain = %q", urls.appDomain)
	}
	refused := []string{urls.appDomain, "inetdev.io.vn"}
	for _, host := range []string{"hoandat.com", "chat.hoandat.com", "x.y.hoandat.com", "inetdev.io.vn", "chat.inetdev.io.vn"} {
		if err := checkHost(host, refused); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Errorf("%s accepted: %v", host, err)
		}
	}
	for _, host := range []string{"nothoandat.com", "hoandat.com.evil.org", "io.vn", "other.io.vn", "example.org"} {
		if err := checkHost(host, refused); err != nil {
			t.Errorf("%s refused: %v", host, err)
		}
	}
	// Development origins on an address or a single label refuse that host.
	for origin, domain := range map[string]string{"https://127.0.0.1:8443": "127.0.0.1", "http://localhost:5173": "localhost", "": ""} {
		u, err := NewURLs(origin)
		if err != nil || u.appDomain != domain {
			t.Errorf("NewURLs(%q) = %+v, %v", origin, u, err)
		}
	}
	if _, err := NewURLs("not a url"); err == nil {
		t.Error("a relative origin was accepted")
	}
}
