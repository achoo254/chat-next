package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/auth"
	"app.local/server/internal/auth/idptest"
	"connectrpc.com/connect"
)

func TestHealthz(t *testing.T) {
	e := newEnv(t)
	resp, err := e.srv.Client().Get(e.srv.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK || body["status"] != "ok" || body["db"] != "connected" {
		t.Fatalf("healthz = %d %v", resp.StatusCode, body)
	}
}

func TestSignInFlow(t *testing.T) {
	e := newEnv(t)
	c := e.browser(t)
	resp, body := e.signIn(t, c, "?locale=vi")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("callback status %d: %s", resp.StatusCode, body)
	}

	// Interstitial: same-site meta refresh, no script, no referrer.
	if !strings.Contains(body, `<meta http-equiv="refresh" content="0;url=/">`) || strings.Contains(body, "<script") {
		t.Fatalf("interstitial = %q", body)
	}
	if got := resp.Header.Get("Referrer-Policy"); got != "no-referrer" {
		t.Fatalf("Referrer-Policy = %q", got)
	}

	// Session cookie attributes, login cookie cleared.
	var sessionSet, loginCleared bool
	for _, raw := range resp.Header.Values("Set-Cookie") {
		switch {
		case strings.HasPrefix(raw, auth.SessionCookieName+"="):
			sessionSet = true
			for _, attr := range []string{"Path=/", "HttpOnly", "Secure", "SameSite=Strict"} {
				if !strings.Contains(raw, attr) {
					t.Errorf("session cookie %q lacks %s", raw, attr)
				}
			}
			if strings.Contains(raw, "Domain=") {
				t.Errorf("session cookie has a Domain: %q", raw)
			}
		case strings.HasPrefix(raw, auth.LoginCookieName+"="):
			loginCleared = strings.Contains(raw, "Max-Age=0")
		}
	}
	if !sessionSet || !loginCleared {
		t.Fatalf("Set-Cookie = %q", resp.Header.Values("Set-Cookie"))
	}

	// The authorization request: PKCE S256, nonce, scope, ui_locales.
	az := e.idp.Authorizes()
	if len(az) != 1 {
		t.Fatalf("authorize calls = %d", len(az))
	}
	q := az[0].Query
	if q.Get("code_challenge_method") != "S256" || q.Get("nonce") == "" || q.Get("state") == "" ||
		q.Get("scope") != "openid profile email" || q.Get("ui_locales") != "vi" || q.Get("prompt") != "" ||
		q.Get("redirect_uri") != e.srv.URL+"/auth/callback" {
		t.Fatalf("authorize query = %v", q)
	}

	// The user exists and the session works.
	u, err := getSelf(t, e.rpc(c, e.srv.URL))
	if err != nil {
		t.Fatal(err)
	}
	if u.GetUsername() != "tester" || u.GetName() != "Người Thử" || u.GetEmail() != "tester@example.com" || !u.GetIsSelf() || u.GetId() <= 0 {
		t.Fatalf("GetSelf = %v", u)
	}
}

func TestSignInPromptCreateAndLocale(t *testing.T) {
	e := newEnv(t)
	c := noRedirect(e.browser(t))
	resp, err := c.Get(e.srv.URL + "/auth/login?prompt=create&locale=zh-CN")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("status %d", resp.StatusCode)
	}
	loc, err := url.Parse(resp.Header.Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if loc.Query().Get("prompt") != "create" || loc.Query().Get("ui_locales") != "zh-CN" {
		t.Fatalf("authorization URL query = %v", loc.Query())
	}
	resp, err = c.Get(e.srv.URL + "/auth/login?prompt=login&locale=fr")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	loc, _ = url.Parse(resp.Header.Get("Location"))
	if loc.Query().Has("prompt") || loc.Query().Has("ui_locales") {
		t.Fatalf("unsupported prompt/locale forwarded: %v", loc.Query())
	}
}

func TestCallbackRejectsStateMismatch(t *testing.T) {
	e := newEnv(t)
	c := noRedirect(e.browser(t))
	resp, err := c.Get(e.srv.URL + "/auth/login")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if e.cookie(t, c, auth.LoginCookieName) == nil {
		t.Fatal("login cookie not set")
	}
	resp, err = c.Get(e.srv.URL + "/auth/callback?code=whatever&state=forged")
	if err != nil {
		t.Fatal(err)
	}
	body := readBody(t, resp)
	if resp.StatusCode != http.StatusBadRequest || !strings.Contains(body, "Thử lại") {
		t.Fatalf("status %d body %q", resp.StatusCode, body)
	}
	if e.cookie(t, c, auth.SessionCookieName) != nil {
		t.Fatal("session cookie set after a state mismatch")
	}
	if e.cookie(t, c, auth.LoginCookieName) != nil {
		t.Fatal("login cookie survived a failed callback")
	}

	// Without any login cookie the callback is rejected too.
	resp, err = e.browser(t).Get(e.srv.URL + "/auth/callback?code=x&state=y")
	if err != nil {
		t.Fatal(err)
	}
	if body := readBody(t, resp); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("no login cookie: status %d body %q", resp.StatusCode, body)
	}
}

func TestCallbackRejectsNonceMismatch(t *testing.T) {
	e := newEnv(t)
	e.idp.SetNonceOverride("not-the-nonce")
	c := e.browser(t)
	resp, body := e.signIn(t, c, "")
	if resp.StatusCode != http.StatusBadRequest || !strings.Contains(body, "Thử lại") {
		t.Fatalf("status %d body %q", resp.StatusCode, body)
	}
	if e.cookie(t, c, auth.SessionCookieName) != nil {
		t.Fatal("session cookie set after a nonce mismatch")
	}
}

func TestSignInUsernameConflictAppendsDigits(t *testing.T) {
	e := newEnv(t)
	first, _ := e.signedIn(t)
	e.idp.SetAccount(idptest.Account{Sub: "acc_other", SID: "sid-2", PreferredUsername: "Tester", Name: "Khác"})
	second, _ := e.signedIn(t)
	a, err := getSelf(t, first)
	if err != nil {
		t.Fatal(err)
	}
	b, err := getSelf(t, second)
	if err != nil {
		t.Fatal(err)
	}
	if a.GetUsername() != "tester" || b.GetUsername() != "tester2" || b.GetEmail() != "" {
		t.Fatalf("users = %v / %v", a, b)
	}
}

func TestLogoutRedirectsToIdPWithHint(t *testing.T) {
	e := newEnv(t)
	cl, c := e.signedIn(t)
	nc := noRedirect(c)

	post := func(origin string) *http.Response {
		req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, e.srv.URL+"/auth/logout", nil)
		if err != nil {
			t.Fatal(err)
		}
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		resp, err := nc.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		return resp
	}

	if resp := post("https://evil.example"); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-origin logout status %d", resp.StatusCode)
	}
	if resp := post(""); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("logout without Origin status %d", resp.StatusCode)
	}

	// SignOut first (as the web does), then the HTTP route.
	if _, err := cl.auth.SignOut(context.Background(), connect.NewRequest(&appv1.SignOutRequest{})); err != nil {
		t.Fatal(err)
	}
	if _, err := getSelf(t, cl); codeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("after SignOut: %v", err)
	}
	resp := post(e.srv.URL)
	if resp.StatusCode != http.StatusSeeOther {
		t.Fatalf("logout status %d", resp.StatusCode)
	}
	loc, err := url.Parse(resp.Header.Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(loc.String(), e.idp.Issuer()+"/session/end?") || loc.Query().Get("id_token_hint") == "" ||
		loc.Query().Get("post_logout_redirect_uri") != e.srv.URL+"/" || loc.Query().Get("client_id") != clientID {
		t.Fatalf("logout Location = %s", loc)
	}
	if e.cookie(t, c, auth.SessionCookieName) != nil {
		t.Fatal("session cookie not cleared")
	}

	// Without a session the route only returns home.
	resp = post(e.srv.URL)
	if resp.StatusCode != http.StatusSeeOther || resp.Header.Get("Location") != "/" {
		t.Fatalf("logout without session: %d %s", resp.StatusCode, resp.Header.Get("Location"))
	}

	// SignOut revoked the refresh token at the IdP.
	e.app.Sessions.Wait()
	if got := e.idp.Revoked(); len(got) != 1 || !strings.HasPrefix(got[0], "rt-") {
		t.Fatalf("revoked at IdP = %v", got)
	}
}
