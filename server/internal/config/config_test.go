package config

import (
	"encoding/base64"
	"errors"
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
		"TENANT_ID":          func(e map[string]string) { e["TENANT_ID"] = "Bad Tenant" },
		"TENANT_DOMAIN":      func(e map[string]string) { e["TENANT_DOMAIN"] = "not a domain" },
		"CHAT_LISTEN_ADDR":   func(e map[string]string) { e["CHAT_LISTEN_ADDR"] = "4600" },
		"APP_URL_SCHEME":     func(e map[string]string) { e["APP_URL_SCHEME"] = "https" },
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
