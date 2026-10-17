package config

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"maps"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const secret = "very-secret-value"

func validEnv() map[string]string {
	return map[string]string{
		"CHAT_ENV":           "production",
		"CHAT_PUBLIC_URL":    "https://chat.hoandat.com",
		"DATABASE_URL":       "postgres://chat:" + secret + "@127.0.0.1:5432/chat",
		"OIDC_ISSUER":        "https://auth.hoandat.com",
		"OIDC_CLIENT_ID":     "chat-web",
		"OIDC_CLIENT_SECRET": secret,
		"SESSION_KEY":        base64.StdEncoding.EncodeToString([]byte(strings.Repeat("k", 32))),
	}
}

func lookupFrom(env map[string]string) Lookup {
	return func(k string) (string, bool) {
		v, ok := env[k]
		return v, ok
	}
}

func TestLoadValid(t *testing.T) {
	env := validEnv()
	env["DEV_ORIGINS"] = "http://localhost:5173"
	c, err := Load(lookupFrom(env))
	if err != nil {
		t.Fatal(err)
	}
	if c.ListenAddr != DefaultListenAddr || c.TenantID != "primary" || c.TenantDomain != "hoandat.com" ||
		c.AppURLScheme != DefaultAppURLScheme {
		t.Fatalf("defaults = %+v", c)
	}
	if c.PublicOrigin() != "https://chat.hoandat.com" || len(c.SessionKey) != 32 || c.Development() {
		t.Fatalf("config = %+v", c)
	}
	if len(c.DevOrigins) != 0 {
		t.Fatalf("DEV_ORIGINS honoured in production: %v", c.DevOrigins)
	}
}

func TestLoadDevelopment(t *testing.T) {
	env := validEnv()
	env["CHAT_ENV"] = "development"
	env["CHAT_PUBLIC_URL"] = "http://localhost:5173/"
	env["OIDC_ISSUER"] = "http://localhost:4500"
	env["DEV_ORIGINS"] = "http://localhost:5173, http://127.0.0.1:5173"
	env["SESSION_KEY"] = base64.RawURLEncoding.EncodeToString([]byte(strings.Repeat("\xff", 40)))
	c, err := Load(lookupFrom(env))
	if err != nil {
		t.Fatal(err)
	}
	if c.PublicOrigin() != "http://localhost:5173" || len(c.DevOrigins) != 2 || c.DevOrigins[1] != "http://127.0.0.1:5173" {
		t.Fatalf("config = %+v", c)
	}
}

func TestLoadErrorsNameVariablesWithoutValues(t *testing.T) {
	cases := map[string]func(map[string]string){
		"CHAT_ENV":           func(e map[string]string) { e["CHAT_ENV"] = "staging" },
		"CHAT_PUBLIC_URL":    func(e map[string]string) { e["CHAT_PUBLIC_URL"] = "http://chat.hoandat.com" },
		"DATABASE_URL":       func(e map[string]string) { delete(e, "DATABASE_URL") },
		"OIDC_ISSUER":        func(e map[string]string) { e["OIDC_ISSUER"] = "http://auth.hoandat.com" },
		"OIDC_CLIENT_SECRET": func(e map[string]string) { e["OIDC_CLIENT_SECRET"] = " " },
		"SESSION_KEY":        func(e map[string]string) { e["SESSION_KEY"] = base64.StdEncoding.EncodeToString([]byte(secret)) },
		"SESSION_KEY_PREVIOUS": func(e map[string]string) {
			e["SESSION_KEY_PREVIOUS"] = base64.StdEncoding.EncodeToString([]byte(secret))
		},
		"TENANT_ID":        func(e map[string]string) { e["TENANT_ID"] = "Bad Tenant" },
		"TENANT_DOMAIN":    func(e map[string]string) { e["TENANT_DOMAIN"] = "not a domain" },
		"CHAT_LISTEN_ADDR": func(e map[string]string) { e["CHAT_LISTEN_ADDR"] = "4600" },
		"APP_URL_SCHEME":   func(e map[string]string) { e["APP_URL_SCHEME"] = "https" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			env := validEnv()
			mutate(env)
			_, err := Load(lookupFrom(env))
			var ve *VarError
			if !errors.As(err, &ve) || ve.Name != name {
				t.Fatalf("err = %v, want a VarError for %s", err, name)
			}
			if strings.Contains(err.Error(), secret) {
				t.Fatalf("error leaks a value: %v", err)
			}
		})
	}
}

func TestLoadReportsEveryMissingVariable(t *testing.T) {
	_, err := Load(lookupFrom(map[string]string{}))
	for _, name := range []string{"CHAT_ENV", "CHAT_PUBLIC_URL", "DATABASE_URL", "OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "SESSION_KEY"} {
		if err == nil || !strings.Contains(err.Error(), name) {
			t.Errorf("error %v does not name %s", err, name)
		}
	}
}

func TestLoadDevOriginsInvalid(t *testing.T) {
	env := validEnv()
	env["CHAT_ENV"] = "development"
	env["DEV_ORIGINS"] = "http://localhost:5173/app"
	if _, err := Load(lookupFrom(env)); err == nil || !strings.Contains(err.Error(), "DEV_ORIGINS") {
		t.Fatalf("err = %v", err)
	}
}

func TestLoadDatabaseURL(t *testing.T) {
	if _, err := LoadDatabaseURL(lookupFrom(nil)); err == nil {
		t.Fatal("missing DATABASE_URL accepted")
	}
	if v, err := LoadDatabaseURL(lookupFrom(map[string]string{"DATABASE_URL": "postgres://x"})); err != nil || v != "postgres://x" {
		t.Fatalf("got %q, %v", v, err)
	}
}

func TestParseEnvFile(t *testing.T) {
	in := `# comment
A=1

  B = two words
C="quoted # not a comment"
D='single'
E=
F=a=b
`
	pairs, err := ParseEnvFile(strings.NewReader(in))
	if err != nil {
		t.Fatal(err)
	}
	want := [][2]string{{"A", "1"}, {"B", "two words"}, {"C", "quoted # not a comment"}, {"D", "single"}, {"E", ""}, {"F", "a=b"}}
	if len(pairs) != len(want) {
		t.Fatalf("pairs = %q", pairs)
	}
	for i := range want {
		if pairs[i] != want[i] {
			t.Fatalf("pair %d = %q, want %q", i, pairs[i], want[i])
		}
	}
}

func TestParseEnvFileErrorsHideContent(t *testing.T) {
	for _, in := range []string{"no-equals-" + secret, "1BAD=" + secret, `K="` + secret} {
		_, err := ParseEnvFile(strings.NewReader(in))
		if err == nil || strings.Contains(err.Error(), secret) || !strings.Contains(err.Error(), "line 1") {
			t.Fatalf("ParseEnvFile(%q) err = %v", in, err)
		}
	}
}

func TestLoadEnvFileKeepsExistingVariables(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chat.env")
	if err := os.WriteFile(path, []byte("CHAT_TEST_KEEP=file\nCHAT_TEST_NEW=file\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CHAT_TEST_KEEP", "process")
	t.Setenv("CHAT_TEST_NEW", "")
	if err := os.Unsetenv("CHAT_TEST_NEW"); err != nil {
		t.Fatal(err)
	}
	if err := LoadEnvFile(path); err != nil {
		t.Fatal(err)
	}
	if got := os.Getenv("CHAT_TEST_KEEP"); got != "process" {
		t.Fatalf("existing variable overridden: %q", got)
	}
	if got := os.Getenv("CHAT_TEST_NEW"); got != "file" {
		t.Fatalf("new variable = %q", got)
	}
	if err := LoadEnvFile(filepath.Join(t.TempDir(), "missing.env")); err == nil {
		t.Fatal("missing file accepted")
	}
}

func TestLoadOperatorUserIDs(t *testing.T) {
	c, err := Load(lookupFrom(validEnv()))
	if err != nil {
		t.Fatal(err)
	}
	if len(c.OperatorUserIDs) != 0 {
		t.Fatalf("operators by default = %v", c.OperatorUserIDs)
	}
	env := validEnv()
	env["CHAT_OPERATOR_USER_IDS"] = " 42, 7,42 ,"
	if c, err = Load(lookupFrom(env)); err != nil {
		t.Fatal(err)
	}
	if len(c.OperatorUserIDs) != 2 || c.OperatorUserIDs[0] != 42 || c.OperatorUserIDs[1] != 7 {
		t.Fatalf("operators = %v", c.OperatorUserIDs)
	}
	for _, bad := range []string{"abc", "0", "-3", "9007199254740992", "1;2"} {
		env["CHAT_OPERATOR_USER_IDS"] = bad
		_, err := Load(lookupFrom(env))
		var ve *VarError
		if !errors.As(err, &ve) || ve.Name != "CHAT_OPERATOR_USER_IDS" {
			t.Errorf("%q: err = %v", bad, err)
		}
	}
}

func TestLoadBotWebhookAllowLocal(t *testing.T) {
	env := validEnv()
	env["BOT_WEBHOOK_ALLOW_LOCAL"] = "true"
	if _, err := Load(lookupFrom(env)); err == nil || !strings.Contains(err.Error(), "BOT_WEBHOOK_ALLOW_LOCAL") {
		t.Fatalf("production with local webhooks: err = %v", err)
	}
	env["CHAT_ENV"] = "development"
	c, err := Load(lookupFrom(env))
	if err != nil || !c.BotWebhookLocal {
		t.Fatalf("development: %+v, %v", c.BotWebhookLocal, err)
	}
	env["BOT_WEBHOOK_ALLOW_LOCAL"] = "yes"
	if _, err := Load(lookupFrom(env)); err == nil {
		t.Fatal("invalid value accepted")
	}
	delete(env, "BOT_WEBHOOK_ALLOW_LOCAL")
	if c, err := Load(lookupFrom(env)); err != nil || c.BotWebhookLocal {
		t.Fatalf("default: %+v, %v", c.BotWebhookLocal, err)
	}
}

func TestLoadOutboundDeny(t *testing.T) {
	env := validEnv()
	c, err := Load(lookupFrom(env))
	if err != nil || len(c.OutboundDeny) != 0 {
		t.Fatalf("default: %v, %v", c.OutboundDeny, err)
	}
	env["OUTBOUND_DENY_CIDRS"] = " 103.72.98.65, 10.9.0.0/16 ,, 2001:db8::1, ::ffff:198.51.100.7, 192.0.2.77/24"
	c, err = Load(lookupFrom(env))
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, p := range c.OutboundDeny {
		got = append(got, p.String())
	}
	if want := "103.72.98.65/32 10.9.0.0/16 2001:db8::1/128 198.51.100.7/32 192.0.2.0/24"; strings.Join(got, " ") != want {
		t.Fatalf("OutboundDeny = %v, want %s", got, want)
	}
	for _, bad := range []string{"103.72.98", "10.0.0.0/33", "fe80::1%eth0", "host.example"} {
		env["OUTBOUND_DENY_CIDRS"] = bad
		if _, err := Load(lookupFrom(env)); err == nil || !strings.Contains(err.Error(), "OUTBOUND_DENY_CIDRS") || strings.Contains(err.Error(), bad) {
			t.Fatalf("%q: err = %v", bad, err)
		}
	}
}

func TestLoadWebPush(t *testing.T) {
	c, err := Load(lookupFrom(validEnv()))
	if err != nil || c.WebPush != nil {
		t.Fatalf("without a key: %+v, %v", c.WebPush, err)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := key.Bytes()
	if err != nil {
		t.Fatal(err)
	}
	vapidSecret := base64.RawURLEncoding.EncodeToString(raw)
	env := validEnv()
	env["WEB_PUSH_VAPID_PRIVATE_KEY"] = vapidSecret
	c, err = Load(lookupFrom(env))
	if err != nil {
		t.Fatal(err)
	}
	if !c.WebPush.VAPIDKey.Equal(key) || c.WebPush.Subject != c.PublicOrigin() || c.WebPush.AllowLocal {
		t.Fatalf("web push %+v", c.WebPush)
	}
	env["WEB_PUSH_SUBJECT"] = "mailto:ops@example.com"
	if c, err = Load(lookupFrom(env)); err != nil || c.WebPush.Subject != "mailto:ops@example.com" {
		t.Fatalf("subject: %+v, %v", c.WebPush, err)
	}
	for name, change := range map[string]map[string]string{
		"WEB_PUSH_VAPID_PRIVATE_KEY": {"WEB_PUSH_VAPID_PRIVATE_KEY": vapidSecret[:20]},
		"WEB_PUSH_SUBJECT":           {"WEB_PUSH_SUBJECT": "ops@example.com"},
		"WEB_PUSH_ALLOW_LOCAL":       {"WEB_PUSH_ALLOW_LOCAL": "true"},
	} {
		bad := validEnv()
		bad["WEB_PUSH_VAPID_PRIVATE_KEY"] = vapidSecret
		maps.Copy(bad, change)
		_, err := Load(lookupFrom(bad))
		if err == nil || !strings.Contains(err.Error(), name) {
			t.Errorf("%s: %v", name, err)
			continue
		}
		if strings.Contains(err.Error(), vapidSecret[:20]) {
			t.Errorf("%s: error shows the key", name)
		}
	}
	dev := validEnv()
	dev["CHAT_ENV"] = EnvDevelopment
	dev["WEB_PUSH_VAPID_PRIVATE_KEY"] = vapidSecret
	dev["WEB_PUSH_ALLOW_LOCAL"] = "true"
	if c, err = Load(lookupFrom(dev)); err != nil || !c.WebPush.AllowLocal {
		t.Fatalf("development: %+v, %v", c.WebPush, err)
	}
}

func TestLoadAbuse(t *testing.T) {
	c, err := Load(lookupFrom(validEnv()))
	if err != nil {
		t.Fatal(err)
	}
	if c.Abuse != DefaultAbuse() {
		t.Fatalf("abuse by default = %+v", c.Abuse)
	}
	// A new account is stopped well before its 50th stranger.
	if d := DefaultAbuse(); d.StrangerChatsNew == 0 || d.StrangerChatsNew >= 50 {
		t.Fatalf("default young allowance = %d", d.StrangerChatsNew)
	}
	env := validEnv()
	env["ABUSE_STRANGER_CHATS_NEW"] = "0"
	env["ABUSE_SIGNUPS_PER_IP_HOUR"] = " 12 "
	if c, err = Load(lookupFrom(env)); err != nil {
		t.Fatal(err)
	}
	if c.Abuse.StrangerChatsNew != 0 || c.Abuse.SignupsPerIPHour != 12 || c.Abuse.StrangerChats != DefaultAbuse().StrangerChats {
		t.Fatalf("abuse = %+v", c.Abuse)
	}
	for _, bad := range []string{"-1", "x", "1.5", "1000001"} {
		env["ABUSE_REPORTERS"] = bad
		_, err := Load(lookupFrom(env))
		var ve *VarError
		if !errors.As(err, &ve) || ve.Name != "ABUSE_REPORTERS" {
			t.Errorf("%q: err = %v", bad, err)
		}
	}
}

func TestSessionKeyPrevious(t *testing.T) {
	env := validEnv()
	prev := []byte(strings.Repeat("p", 32))
	env["SESSION_KEY_PREVIOUS"] = base64.StdEncoding.EncodeToString(prev)
	c, err := Load(lookupFrom(env))
	if err != nil || string(c.SessionKeyPrevious) != string(prev) {
		t.Fatalf("previous key = %q, %v", c.SessionKeyPrevious, err)
	}
	env["SESSION_KEY_PREVIOUS"] = env["SESSION_KEY"]
	var ve *VarError
	if _, err := Load(lookupFrom(env)); !errors.As(err, &ve) || ve.Name != "SESSION_KEY_PREVIOUS" {
		t.Fatalf("same key twice: %v", err)
	}
}

func TestLoadMaxOnlineUsers(t *testing.T) {
	env := validEnv()
	if c, err := Load(lookupFrom(env)); err != nil || c.MaxOnlineUsers != DefaultMaxOnlineUsers {
		t.Fatalf("default: %d, %v", c.MaxOnlineUsers, err)
	}
	env["CHAT_MAX_ONLINE_USERS"] = "0"
	if c, err := Load(lookupFrom(env)); err != nil || c.MaxOnlineUsers != 0 {
		t.Fatalf("no cap: %d, %v", c.MaxOnlineUsers, err)
	}
	env["CHAT_MAX_ONLINE_USERS"] = "-5"
	if _, err := Load(lookupFrom(env)); err == nil || !strings.Contains(err.Error(), "CHAT_MAX_ONLINE_USERS") {
		t.Fatalf("negative: %v", err)
	}
}
