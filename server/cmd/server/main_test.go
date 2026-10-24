package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// clearConfigEnv unsets every configuration variable for the test.
func clearConfigEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{"CHAT_ENV", "CHAT_LISTEN_ADDR", "CHAT_PUBLIC_URL", "DATABASE_URL", "OIDC_ISSUER",
		"OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "SESSION_KEY", "TENANT_DOMAIN", "DEV_ORIGINS"} {
		t.Setenv(k, "")
		if err := os.Unsetenv(k); err != nil {
			t.Fatal(err)
		}
	}
}

func TestRunRejectsUnknownRole(t *testing.T) {
	var stderr bytes.Buffer
	if code := run([]string{"-role", "nope"}, &stderr); code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
	if !strings.Contains(stderr.String(), "unknown role") {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func TestRunAcceptsEveryRole(t *testing.T) {
	clearConfigEnv(t)
	for _, role := range Roles {
		var stderr bytes.Buffer
		if code := run([]string{"-role", role}, &stderr); code == 2 {
			t.Fatalf("role %q rejected: %s", role, stderr.String())
		}
	}
}

func TestRunUnimplementedRoles(t *testing.T) {
	for _, role := range []string{"gateway", "worker", "botapi", "webhook"} {
		var stderr bytes.Buffer
		if code := run([]string{"-role", role}, &stderr); code != 1 || !strings.Contains(stderr.String(), "not implemented") {
			t.Fatalf("role %q: code %d, stderr %q", role, code, stderr.String())
		}
	}
}

func TestRunAPIRejectsMissingConfigWithoutValues(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("OIDC_CLIENT_SECRET", "top-secret-value")
	var stderr bytes.Buffer
	if code := run([]string{"-role", "api"}, &stderr); code != 1 {
		t.Fatalf("exit code = %d, want 1", code)
	}
	out := stderr.String()
	if !strings.Contains(out, "DATABASE_URL") || !strings.Contains(out, "SESSION_KEY") {
		t.Fatalf("stderr does not name the missing variables: %q", out)
	}
	if strings.Contains(out, "top-secret-value") {
		t.Fatalf("stderr leaks a value: %q", out)
	}
}

func TestRunMigrateNeedsDatabaseURL(t *testing.T) {
	clearConfigEnv(t)
	var stderr bytes.Buffer
	code := run([]string{"-role", "migrate"}, &stderr)
	if code != 1 || !strings.Contains(stderr.String(), "DATABASE_URL") {
		t.Fatalf("code %d, stderr %q", code, stderr.String())
	}
}

func TestRunEnvFile(t *testing.T) {
	clearConfigEnv(t)
	var stderr bytes.Buffer
	if code := run([]string{"-role", "migrate", "-env-file", filepath.Join(t.TempDir(), "missing.env")}, &stderr); code != 1 {
		t.Fatalf("missing env file: code %d", code)
	}
	path := filepath.Join(t.TempDir(), "chat.env")
	// Port 1 refuses connections, so the migration fails after the file
	// supplied DATABASE_URL.
	if err := os.WriteFile(path, []byte("# test\nDATABASE_URL='postgres://u:p@127.0.0.1:1/db?connect_timeout=2'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	stderr.Reset()
	if code := run([]string{"-role", "migrate", "-env-file", path}, &stderr); code != 1 {
		t.Fatalf("code %d", code)
	}
	if strings.Contains(stderr.String(), "invalid configuration") {
		t.Fatalf("env file not loaded: %q", stderr.String())
	}
	if strings.Contains(stderr.String(), "u:p@") {
		t.Fatalf("stderr leaks the database URL: %q", stderr.String())
	}
}
