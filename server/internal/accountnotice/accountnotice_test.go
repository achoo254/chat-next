package accountnotice_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/accountnotice"
	"app.local/server/internal/assistant"
	"app.local/server/internal/auth"
	"app.local/server/internal/auth/idptest"
	"app.local/server/internal/botapi"
	"app.local/server/internal/bottest"
	"app.local/server/internal/brand"
	"app.local/server/internal/ratelimit"
	"app.local/server/internal/store/testdb"
)

const audience = bottest.PublicOrigin + accountnotice.Path

func TestMain(m *testing.M) {
	os.Exit(testdb.Main(m))
}

// recorder counts the deliveries it passes on to the assistant.
type recorder struct {
	inner accountnotice.Notifier
	mu    sync.Mutex
	calls int
}

func (r *recorder) NotifyAccount(ctx context.Context, userID int64, text string) error {
	r.mu.Lock()
	r.calls++
	r.mu.Unlock()
	return r.inner.NotifyAccount(ctx, userID, text)
}

func (r *recorder) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.calls
}

type world struct {
	t         *testing.T
	env       *bottest.Env
	idp       *idptest.Provider
	verifier  *auth.IdP
	assistant *assistant.Service
	notifier  *recorder
	srv       *httptest.Server
	user      int64
	sub       string
	// logs collects the handler's log, to check no token or text is in it.
	logs *bytes.Buffer
}

func newWorld(t *testing.T) *world {
	t.Helper()
	ctx := context.Background()
	env := bottest.New(t)
	api, err := botapi.New(botapi.Config{TenantID: bottest.TenantID, PublicOrigin: bottest.PublicOrigin, AppScheme: bottest.AppScheme,
		MiniAppKey: env.MiniApp.PublicKey()},
		env.Chat, env.Admin, env.Updates, env.Limiter, bottest.Quiet)
	if err != nil {
		t.Fatal(err)
	}
	a, err := assistant.New(env.Chat, env.Admin, env.Updates, api, brand.Names{AppName: "Demo App", ShortName: "Demo"}, bottest.Quiet)
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Ensure(ctx); err != nil {
		t.Fatal(err)
	}
	provider := idptest.New(t, "chat-web", "secret")
	verifier := auth.NewIdP(auth.IdPConfig{
		Issuer: provider.Issuer(), ClientID: "chat-web", ClientSecret: "secret", RedirectURL: bottest.PublicOrigin + "/auth/callback",
		HTTPClient: provider.Server.Client(), Logger: bottest.Quiet,
	})
	if err := verifier.Discover(ctx); err != nil {
		t.Fatal(err)
	}
	user := env.User("lan")
	u, err := env.Store.UserByID(ctx, bottest.TenantID, user)
	if err != nil {
		t.Fatal(err)
	}
	w := &world{t: t, env: env, idp: provider, verifier: verifier, assistant: a, notifier: &recorder{inner: a},
		user: user, sub: u.IdPSub, logs: &bytes.Buffer{}}
	w.serve(w.notifier)
	return w
}

// serve (re)starts the endpoint with notifier (nil: the assistant is off).
func (w *world) serve(notifier accountnotice.Notifier) {
	w.t.Helper()
	if w.srv != nil {
		w.srv.Close()
	}
	logger := slog.New(slog.NewTextHandler(w.logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	h, err := accountnotice.New(accountnotice.Config{TenantID: bottest.TenantID, Audience: audience},
		w.env.Store, w.verifier, notifier, ratelimit.NewMemory(), logger)
	if err != nil {
		w.t.Fatal(err)
	}
	mux := http.NewServeMux()
	h.Register(mux)
	w.srv = httptest.NewServer(mux)
	w.t.Cleanup(w.srv.Close)
}

// token signs a notice token for sub, as the IdP does; mods change the
// claims (or return a typ to sign with) to build bad tokens.
func (w *world) token(sub string, mods ...func(claims map[string]any) string) string {
	w.t.Helper()
	claims := map[string]any{
		"iss": w.idp.Issuer(), "aud": audience, "sub": sub, "client_id": accountnotice.ClientID,
		"scope": accountnotice.Scope, "iat": time.Now().Unix(), "exp": time.Now().Add(time.Minute).Unix(), "jti": "jti-1",
	}
	typ := "at+jwt"
	for _, mod := range mods {
		if v := mod(claims); v != "" {
			typ = v
		}
	}
	tok, err := w.idp.Sign(claims, typ)
	if err != nil {
		w.t.Fatal(err)
	}
	return tok
}

// post sends body with the bearer token (none when empty) and returns the
// status, the error code of the body and the WWW-Authenticate header.
func (w *world) post(token, body string) (int, string, string) {
	w.t.Helper()
	req, err := http.NewRequest(http.MethodPost, w.srv.URL+accountnotice.Path, strings.NewReader(body))
	if err != nil {
		w.t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := w.srv.Client().Do(req)
	if err != nil {
		w.t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	var out struct {
		Error string `json:"error"`
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		w.t.Fatal(err)
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &out); err != nil {
			w.t.Fatalf("body %q: %v", raw, err)
		}
	}
	return resp.StatusCode, out.Error, resp.Header.Get("WWW-Authenticate")
}

// botMessages returns the texts the assistant sent to the user.
func (w *world) botMessages() []string {
	w.t.Helper()
	ctx := context.Background()
	dialogs, err := w.env.Chat.GetDialogs(ctx, w.user, "", 0)
	if err != nil {
		w.t.Fatal(err)
	}
	var out []string
	for _, c := range dialogs.GetChats() {
		if c.GetPeerUserId() != w.assistant.BotID() {
			continue
		}
		resp, err := w.env.Chat.GetHistory(ctx, w.user, &appv1.GetHistoryRequest{ChatId: c.GetId(), Limit: 100})
		if err != nil {
			w.t.Fatal(err)
		}
		for _, m := range resp.GetMessages() {
			if m.GetFromId() == w.assistant.BotID() {
				out = append(out, m.GetText())
			}
		}
	}
	return out
}

func body(text string) string {
	b, err := json.Marshal(map[string]string{"text": text})
	if err != nil {
		panic(err)
	}
	return string(b)
}

// A valid notice reaches the user as a message of the assistant, even when
// they never pressed Start, and neither the token nor the text is logged.
func TestNoticeIsSentByTheAssistant(t *testing.T) {
	w := newWorld(t)
	tok := w.token(w.sub)
	const text = "Đăng nhập mới\n\nTài khoản của bạn vừa đăng nhập trên Chrome."
	if status, code, _ := w.post(tok, body("  "+text+"\n")); status != http.StatusNoContent {
		t.Fatalf("status = %d %q", status, code)
	}
	if got := w.botMessages(); len(got) != 1 || got[0] != text {
		t.Fatalf("assistant messages = %q", got)
	}
	logs := w.logs.String()
	if strings.Contains(logs, tok) || strings.Contains(logs, "Chrome") || strings.Contains(logs, w.sub) {
		t.Fatalf("the log carries the token, the text or the account: %s", logs)
	}
}

// A user who blocked the assistant gets nothing, and the IdP sees the same
// 204.
func TestBlockedAssistantSendsNothing(t *testing.T) {
	w := newWorld(t)
	if err := w.env.Chat.Block(context.Background(), w.user, w.assistant.BotID()); err != nil {
		t.Fatal(err)
	}
	if status, code, _ := w.post(w.token(w.sub), body("Mật khẩu đã đổi")); status != http.StatusNoContent {
		t.Fatalf("status = %d %q", status, code)
	}
	if got := w.botMessages(); len(got) != 0 {
		t.Fatalf("a blocked assistant sent %q", got)
	}
}

// Without the assistant every valid notice is answered 204 and dropped.
func TestAssistantOffAnswersNoContent(t *testing.T) {
	w := newWorld(t)
	w.serve(nil)
	if status, code, _ := w.post(w.token(w.sub), body("x")); status != http.StatusNoContent {
		t.Fatalf("status = %d %q", status, code)
	}
	if got := w.botMessages(); len(got) != 0 {
		t.Fatalf("messages without the assistant: %q", got)
	}
}

func TestRejectedNotices(t *testing.T) {
	w := newWorld(t)
	valid := body("Thông báo")
	tests := []struct {
		name   string
		token  func() string
		body   string
		status int
		code   string
		// challenge is the WWW-Authenticate header expected ("" for none).
		challenge string
	}{
		{name: "unknown account", token: func() string { return w.token("acc_nobody") }, body: valid, status: http.StatusNoContent},
		{name: "no token", token: func() string { return "" }, body: valid, status: http.StatusUnauthorized, code: "invalid_token",
			challenge: "Bearer"},
		{name: "not a JWT", token: func() string { return "abc" }, body: valid, status: http.StatusUnauthorized, code: "invalid_token",
			challenge: `Bearer error="invalid_token"`},
		{name: "audience of the MCP resource", token: func() string {
			return w.token(w.sub, func(c map[string]any) string { c["aud"] = bottest.PublicOrigin + "/mcp"; return "" })
		}, body: valid, status: http.StatusUnauthorized, code: "invalid_token", challenge: `Bearer error="invalid_token"`},
		{name: "expired", token: func() string {
			return w.token(w.sub, func(c map[string]any) string {
				c["iat"], c["exp"] = time.Now().Add(-10*time.Minute).Unix(), time.Now().Add(-5*time.Minute).Unix()
				return ""
			})
		}, body: valid, status: http.StatusUnauthorized, code: "invalid_token", challenge: `Bearer error="invalid_token"`},
		{name: "ID token typ", token: func() string {
			return w.token(w.sub, func(map[string]any) string { return "JWT" })
		}, body: valid, status: http.StatusUnauthorized, code: "invalid_token", challenge: `Bearer error="invalid_token"`},
		{name: "another client", token: func() string {
			return w.token(w.sub, func(c map[string]any) string { c["client_id"] = "tunelo-agent"; return "" })
		}, body: valid, status: http.StatusForbidden, code: "insufficient_scope",
			challenge: `Bearer error="insufficient_scope", scope="account-notices"`},
		{name: "missing scope", token: func() string {
			return w.token(w.sub, func(c map[string]any) string { c["scope"] = "chat:read"; return "" })
		}, body: valid, status: http.StatusForbidden, code: "insufficient_scope",
			challenge: `Bearer error="insufficient_scope", scope="account-notices"`},
		{name: "empty text", token: func() string { return w.token(w.sub) }, body: body(" \n\t "),
			status: http.StatusBadRequest, code: "invalid_request"},
		{name: "no text", token: func() string { return w.token(w.sub) }, body: `{}`,
			status: http.StatusBadRequest, code: "invalid_request"},
		{name: "not JSON", token: func() string { return w.token(w.sub) }, body: `text=hi`,
			status: http.StatusBadRequest, code: "invalid_request"},
		{name: "too long text", token: func() string { return w.token(w.sub) }, body: body(strings.Repeat("ạ", accountnotice.MaxTextRunes+1)),
			status: http.StatusBadRequest, code: "invalid_request"},
		{name: "too large body", token: func() string { return w.token(w.sub) }, body: body(strings.Repeat("a", 9<<10)),
			status: http.StatusRequestEntityTooLarge, code: "invalid_request"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			before := w.notifier.count()
			status, code, challenge := w.post(tt.token(), tt.body)
			if status != tt.status || code != tt.code || challenge != tt.challenge {
				t.Fatalf("got %d %q %q, want %d %q %q", status, code, challenge, tt.status, tt.code, tt.challenge)
			}
			if n := w.notifier.count() - before; n != 0 {
				t.Fatalf("%d deliveries", n)
			}
		})
	}
	if got := w.botMessages(); len(got) != 0 {
		t.Fatalf("rejected notices sent %q", got)
	}
}

// The longest notice passes; the account's budget ends at 30 a minute.
func TestLongestTextAndRateLimit(t *testing.T) {
	w := newWorld(t)
	tok := w.token(w.sub)
	if status, code, _ := w.post(tok, body(strings.Repeat("ạ", accountnotice.MaxTextRunes))); status != http.StatusNoContent {
		t.Fatalf("longest text: %d %q", status, code)
	}
	for i := 1; i < 30; i++ {
		// A refused text still takes from the budget (it is taken first).
		if status, _, _ := w.post(tok, body(" ")); status != http.StatusBadRequest {
			t.Fatalf("call %d: %d", i+1, status)
		}
	}
	if status, code, _ := w.post(tok, body("x")); status != http.StatusTooManyRequests || code != "rate_limited" {
		t.Fatalf("over the budget: %d %q", status, code)
	}
	// Another account has its own budget.
	if status, _, _ := w.post(w.token("acc_other"), body("x")); status != http.StatusNoContent {
		t.Fatalf("another account: %d", status)
	}
	if n := w.notifier.count(); n != 1 {
		t.Fatalf("%d deliveries", n)
	}
}
