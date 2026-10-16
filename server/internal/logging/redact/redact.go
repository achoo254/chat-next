// Package redact keeps secrets and personal data out of the server logs.
//
// Every server logger runs its attributes through ReplaceAttr. An attribute
// whose key names a secret or personal data (token, secret, cookie, email…)
// loses its value outright. Any other text — the message, string values and
// errors, which often quote URLs or upstream answers — is scanned for the
// shapes a secret takes in this app: bearer credentials, JWTs (IdP ID and
// logout tokens), bot tokens, incoming hook URLs, credentials in a URL or a
// query string (OIDC code and state, tokens), and email addresses.
//
// An opaque secret alone in a text (a client secret, a refresh token) has no
// shape to find: code must log it under a sensitive key or not at all. The
// api tests scan the logs of every flow they drive for such leaks.
package redact

import (
	"fmt"
	"log/slog"
	"regexp"
	"strings"
)

// Mask replaces a redacted value or the secret part of a text.
const Mask = "[redacted]"

// HandlerOptions returns handler options at level with ReplaceAttr set.
func HandlerOptions(level slog.Leveler) *slog.HandlerOptions {
	return &slog.HandlerOptions{Level: level, ReplaceAttr: ReplaceAttr}
}

// ReplaceAttr is a slog.HandlerOptions.ReplaceAttr that redacts a.
func ReplaceAttr(groups []string, a slog.Attr) slog.Attr {
	if len(groups) == 0 && (a.Key == slog.TimeKey || a.Key == slog.LevelKey || a.Key == slog.SourceKey) {
		return a
	}
	if len(groups) > 0 || a.Key != slog.MessageKey {
		if SensitiveKey(a.Key) {
			return slog.String(a.Key, Mask)
		}
	}
	switch a.Value.Kind() {
	case slog.KindString:
		s := a.Value.String()
		if r := String(s); r != s {
			return slog.String(a.Key, r)
		}
	case slog.KindAny:
		var s string
		switch v := a.Value.Any().(type) {
		case nil:
			return a
		case error:
			s = v.Error()
		default:
			s = fmt.Sprint(v)
		}
		// Errors are logged as their text anyway; other values keep their
		// own encoding unless they quote a secret.
		r := String(s)
		if _, isErr := a.Value.Any().(error); isErr || r != s {
			return slog.String(a.Key, r)
		}
	}
	return a
}

// secretWords make any key that contains them sensitive.
var secretWords = []string{
	"token", "secret", "password", "passwd", "cookie", "authorization", "credential",
	"apikey", "api_key", "private_key", "session_key", "signing_key", "database_url", "email",
}

// secretKeys are sensitive only as the whole key: "code" is the OIDC
// authorization code; codes of other kinds are logged under their own name
// (sqlstate, rpc_code).
var secretKeys = map[string]bool{
	"code": true, "nonce": true, "dsn": true,
	"ip": true, "client_ip": true, "remote_ip": true, "remote_addr": true, "x_forwarded_for": true,
}

// SensitiveKey reports whether a value logged under key must not appear.
func SensitiveKey(key string) bool {
	k := strings.ToLower(strings.NewReplacer("-", "_", ".", "_").Replace(key))
	if secretKeys[k] {
		return true
	}
	for _, w := range secretWords {
		if strings.Contains(k, w) {
			return true
		}
	}
	return false
}

type rule struct {
	re   *regexp.Regexp
	repl string
}

// rules run in order: URL credentials go before email addresses so that
// "user:password@host" loses the password, not just look like an address.
var rules = []rule{
	{regexp.MustCompile(`(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}`), "$1 " + Mask},
	{regexp.MustCompile(`eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*`), Mask},
	{regexp.MustCompile(`(://)[^/\s@"'<>]+@`), "${1}" + Mask + "@"},
	{regexp.MustCompile(`(/hook/[^/\s"'?#]+/)[^/\s"'?#]+`), "${1}" + Mask},
	{regexp.MustCompile(`(?i)((?:^|[?&;\s"'])(?:code|state|token|access_token|refresh_token|id_token|id_token_hint|logout_token|` +
		`secret|client_secret|secret_token|api_key|apikey|key|password|sig|signature)=)[^&\s"'#]*`), "${1}" + Mask},
	{regexp.MustCompile(`(^|[^0-9A-Za-z_-])([1-9][0-9]{0,15}):[A-Za-z0-9_-]{35,128}`), "${1}${2}:" + Mask},
	{regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}`), Mask},
}

// String returns s with every secret or email address in it masked.
func String(s string) string {
	for _, r := range rules {
		s = r.re.ReplaceAllString(s, r.repl)
	}
	return s
}
