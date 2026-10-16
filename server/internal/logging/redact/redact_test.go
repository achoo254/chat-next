package redact_test

import (
	"bytes"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"testing"

	"app.local/server/internal/logging/redact"
)

const botSecret = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-xy"

func TestString(t *testing.T) {
	cases := []struct{ in, want string }{
		{"Authorization: Bearer abc.def-ghi", "Authorization: Bearer " + redact.Mask},
		{"id_token eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl end", "id_token " + redact.Mask + " end"},
		{`Post "https://bob:hunter2@example.org/x": EOF`, `Post "https://` + redact.Mask + `@example.org/x": EOF`},
		{"POST /hook/h_1/s3cr3tValue/slack", "POST /hook/h_1/" + redact.Mask + "/slack"},
		{"GET /auth/callback?code=abc123&state=xyz&locale=vi", "GET /auth/callback?code=" + redact.Mask + "&state=" + redact.Mask + "&locale=vi"},
		{"grant_type=refresh_token&refresh_token=rt-1&client_secret=cs", "grant_type=refresh_token&refresh_token=" + redact.Mask + "&client_secret=" + redact.Mask},
		{"bad token 42:" + botSecret + " rejected", "bad token 42:" + redact.Mask + " rejected"},
		{"user tester@example.com signed in", "user " + redact.Mask + " signed in"},
		// Ordinary text stays as it is.
		{"migration applied 20 at 12:30:45 for chat 9007199254740991", "migration applied 20 at 12:30:45 for chat 9007199254740991"},
		{"listen 127.0.0.1:4600 https://chat.hoandat.com", "listen 127.0.0.1:4600 https://chat.hoandat.com"},
	}
	for _, c := range cases {
		if got := redact.String(c.in); got != c.want {
			t.Errorf("String(%q)\n got %q\nwant %q", c.in, got, c.want)
		}
	}
}

func TestSensitiveKey(t *testing.T) {
	for _, k := range []string{"token", "refresh_token", "idToken", "secret", "webhook-secret", "Cookie", "authorization",
		"email", "code", "nonce", "ip", "api_key", "session.key", "database_url"} {
		if !redact.SensitiveKey(k) {
			t.Errorf("%q is not sensitive", k)
		}
	}
	for _, k := range []string{"user_id", "bot_id", "sqlstate", "rpc_code", "status", "key", "host", "addr", "reason", "kind"} {
		if redact.SensitiveKey(k) {
			t.Errorf("%q is sensitive", k)
		}
	}
}

type secretCarrier struct{ URL string }

func TestHandlers(t *testing.T) {
	for name, newHandler := range map[string]func(*bytes.Buffer) slog.Handler{
		"json": func(b *bytes.Buffer) slog.Handler {
			return slog.NewJSONHandler(b, redact.HandlerOptions(slog.LevelDebug))
		},
		"text": func(b *bytes.Buffer) slog.Handler {
			return slog.NewTextHandler(b, redact.HandlerOptions(slog.LevelDebug))
		},
	} {
		t.Run(name, func(t *testing.T) {
			var buf bytes.Buffer
			logger := slog.New(newHandler(&buf)).With("cookie", "sess-cookie-value")
			logger.Info("callback for tester@example.com",
				"code", "oidc-code-value",
				"err", fmt.Errorf("exchange: %w", errors.New(`Post "https://idp.example/token?client_secret=cs-value": EOF`)),
				slog.Group("bot", "token", "7:"+botSecret, "id", 7),
				"carrier", secretCarrier{URL: "https://x.example/hook/h1/hook-secret-value"},
				"user_id", 12, "kind", "message")
			logger.Debug("debug lines are redacted too", "refresh_token", "rt-value")
			out := buf.String()
			for _, leak := range []string{"tester@example.com", "oidc-code-value", "cs-value", botSecret,
				"hook-secret-value", "sess-cookie-value", "rt-value"} {
				if strings.Contains(out, leak) {
					t.Errorf("%q leaked:\n%s", leak, out)
				}
			}
			for _, kept := range []string{"user_id", "12", "message", "/hook/h1/", "debug lines are redacted too", "exchange: Post"} {
				if !strings.Contains(out, kept) {
					t.Errorf("%q missing:\n%s", kept, out)
				}
			}
		})
	}
}
