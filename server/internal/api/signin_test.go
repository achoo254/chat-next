package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

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

// userAgentTransport sends a fixed User-Agent header.
type userAgentTransport struct {
	ua   string
	next http.RoundTripper
}

func (u userAgentTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("User-Agent", u.ua)
	return u.next.RoundTrip(r)
}

func TestSignInWithInvalidUTF8UserAgent(t *testing.T) {
	e := newEnv(t)
	c := e.browser(t)
	// Header values may carry any byte from 0x80; PostgreSQL text accepts
	// only valid UTF-8. The multi-byte runes straddle the 512-byte cut.
	c.Transport = userAgentTransport{ua: "Mozilla/5.0 \xff\xfe\xc3 " + strings.Repeat("ữ", 400), next: c.Transport}
	e.mustSignIn(t, c)
	cl := e.rpc(c, e.srv.URL)
	resp, err := cl.auth.ListSessions(context.Background(), connect.NewRequest(&appv1.ListSessionsRequest{}))
	if err != nil || len(resp.Msg.GetSessions()) != 1 {
		t.Fatalf("ListSessions = %v, %v", resp, err)
	}
}

func TestRevokedSessionsLoseIDToken(t *testing.T) {
	e := newEnv(t)
	victim, victimBrowser := e.signedIn(t)
	bystander, bystanderBrowser := e.signedIn(t)
	actor, _ := e.signedIn(t)
	ctx := context.Background()

	// Revoked from another session: its cookie no longer yields the ID token.
	id := currentSessionID(t, victim)
	if _, err := actor.auth.RevokeSession(ctx, connect.NewRequest(&appv1.RevokeSessionRequest{SessionId: id})); err != nil {
		t.Fatal(err)
	}
	if loc := e.postLogout(t, victimBrowser); loc != "/" {
		t.Fatalf("logout after revocation by another session redirected to %q", loc)
	}

	// Same for every session ended by RevokeOtherSessions.
	if _, err := actor.auth.RevokeOtherSessions(ctx, connect.NewRequest(&appv1.RevokeOtherSessionsRequest{})); err != nil {
		t.Fatal(err)
	}
	if _, err := getSelf(t, bystander); codeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("other session still works: %v", err)
	}
	if loc := e.postLogout(t, bystanderBrowser); loc != "/" {
		t.Fatalf("logout after RevokeOtherSessions redirected to %q", loc)
	}
}

func TestRevokingOwnSessionKeepsLogoutHint(t *testing.T) {
	e := newEnv(t)
	cl, c := e.signedIn(t)
	id := currentSessionID(t, cl)
	if _, err := cl.auth.RevokeSession(context.Background(), connect.NewRequest(&appv1.RevokeSessionRequest{SessionId: id})); err != nil {
		t.Fatal(err)
	}
	loc, err := url.Parse(e.postLogout(t, c))
	if err != nil || loc.Query().Get("id_token_hint") == "" {
		t.Fatalf("logout after revoking the own session = %v, %v", loc, err)
	}
}

// return_to survives the IdP round trip inside the sealed login cookie;
// anything that could leave the origin falls back to "/".
func TestSignInReturnsToPage(t *testing.T) {
	e := newEnv(t)
	for raw, want := range map[string]string{
		"/chat/42?topic=3":     "/chat/42?topic=3",
		"//evil.example":       "/",
		"/\\evil.example":      "/",
		"https://evil.example": "/",
		"/\t/evil.example":     "/",
		"/auth/logout":         "/",
		"":                     "/",
	} {
		c := e.browser(t)
		resp, body := e.signIn(t, c, "?"+url.Values{"return_to": {raw}}.Encode())
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%q: status %d", raw, resp.StatusCode)
		}
		meta := `<meta http-equiv="refresh" content="0;url=` + strings.ReplaceAll(want, "&", "&amp;") + `">`
		if !strings.Contains(body, meta) || strings.Contains(body, "evil") {
			t.Errorf("return_to %q: interstitial = %q", raw, body)
		}
	}
}

// listSessions returns the active sessions the clients' user sees.
func listSessions(t *testing.T, cl clients) []*appv1.Session {
	t.Helper()
	resp, err := cl.auth.ListSessions(context.Background(), connect.NewRequest(&appv1.ListSessionsRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	return resp.Msg.GetSessions()
}

func TestSignInAgainReplacesTheBrowsersSession(t *testing.T) {
	e := newEnv(t)
	other, _ := e.signedIn(t) // another browser of the same user
	cl, c := e.signedIn(t)
	before := currentSessionID(t, cl)

	// Confirming a sensitive action signs in again in the same browser and
	// the same IdP session: the old session goes, the IdP grant they share stays.
	resp, body := e.signIn(t, c, "?reauth=1")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("re-sign-in status %d: %s", resp.StatusCode, body)
	}
	sessions := listSessions(t, cl)
	if len(sessions) != 2 {
		t.Fatalf("sessions after re-sign-in = %d, want this browser once and the other browser", len(sessions))
	}
	after := currentSessionID(t, cl)
	if after == before {
		t.Fatal("re-sign-in kept the old session current")
	}
	for _, s := range sessions {
		if s.GetId() == before {
			t.Fatal("the replaced session is still listed")
		}
	}
	if _, err := getSelf(t, other); err != nil {
		t.Fatalf("the other browser's session ended: %v", err)
	}
	e.app.Sessions.Wait()
	if got := e.idp.Revoked(); len(got) != 0 {
		t.Fatalf("revoked at IdP = %d tokens, want none: the grant is shared with the new session", len(got))
	}

	// A sign-in under another IdP session has its own grant: the replaced
	// session's refresh token is revoked at the IdP.
	e.idp.SetAccount(idptest.Account{Sub: "acc_test", SID: "sid-other", PreferredUsername: "tester", Name: "Người Thử",
		Email: "tester@example.com", EmailVerified: true})
	e.mustSignIn(t, c)
	if n := len(listSessions(t, cl)); n != 2 {
		t.Fatalf("sessions after a sign-in under a new IdP session = %d, want 2", n)
	}
	e.app.Sessions.Wait()
	if got := e.idp.Revoked(); len(got) != 1 {
		t.Fatalf("revoked at IdP = %d tokens, want the replaced session's", len(got))
	}
}

func TestSignInWithoutASessionCookieReplacesNothing(t *testing.T) {
	e := newEnv(t)
	first, _ := e.signedIn(t)
	second, _ := e.signedIn(t)
	if n := len(listSessions(t, first)); n != 2 {
		t.Fatalf("sessions = %d, want one per browser", n)
	}
	if _, err := getSelf(t, second); err != nil {
		t.Fatal(err)
	}
}

// sessionRevokeState reads whether a session is revoked, and why.
func (e *env) sessionRevokeState(t *testing.T, id int64) (revoked bool, reason int32) {
	t.Helper()
	var r *int32
	err := e.store.Pool().QueryRow(context.Background(),
		`SELECT revoked_at IS NOT NULL, revoke_reason FROM user_sessions WHERE id = $1`, id).Scan(&revoked, &r)
	if err != nil {
		t.Fatal(err)
	}
	if r != nil {
		reason = *r
	}
	return revoked, reason
}

func TestSignInAgainSendsTheNewCookieBeforeRevokingTheOldSession(t *testing.T) {
	e := newEnv(t)
	cl, c := e.signedIn(t)
	before := currentSessionID(t, cl)
	oldCookie := e.cookie(t, c, auth.SessionCookieName).Value

	// Hold the old session's row: revoking it waits until the lock goes.
	ctx := context.Background()
	tx, err := e.store.Pool().Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT 1 FROM user_sessions WHERE id = $1 FOR UPDATE`, before); err != nil {
		t.Fatal(err)
	}

	// The browser gets the whole page and the new cookie while the
	// revocation still waits.
	timed := *c
	timed.Timeout = 10 * time.Second
	resp, body := e.signIn(t, &timed, "?reauth=1")
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, `http-equiv="refresh"`) {
		t.Fatalf("re-sign-in: status %d body %q", resp.StatusCode, body)
	}
	if got := e.cookie(t, c, auth.SessionCookieName).Value; got == oldCookie {
		t.Fatal("the browser still holds the old cookie")
	}
	if revoked, _ := e.sessionRevokeState(t, before); revoked {
		t.Fatal("the old session was revoked before the response reached the browser")
	}

	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		revoked, reason := e.sessionRevokeState(t, before)
		if revoked {
			if reason != int32(appv1.SessionRevokeReason_SESSION_REVOKE_REASON_REPLACED) {
				t.Fatalf("revoke reason = %d, want REPLACED", reason)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the old session was never revoked")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestSignInAsAnotherUserOnTheSameBrowser(t *testing.T) {
	e := newEnv(t)
	cl, c := e.signedIn(t)
	before := currentSessionID(t, cl)

	e.idp.SetAccount(idptest.Account{Sub: "acc_bob", SID: "sid-bob", PreferredUsername: "bob", Name: "Bob"})
	e.mustSignIn(t, c)
	self, err := getSelf(t, cl)
	if err != nil {
		t.Fatal(err)
	}
	if self.GetUsername() != "bob" {
		t.Fatalf("browser signed in as %q, want bob", self.GetUsername())
	}
	if revoked, reason := e.sessionRevokeState(t, before); !revoked ||
		reason != int32(appv1.SessionRevokeReason_SESSION_REVOKE_REASON_REPLACED) {
		t.Fatalf("previous user's session: revoked %v reason %d, want REPLACED", revoked, reason)
	}
	// Two accounts never share an IdP grant: the previous user's refresh
	// token is revoked at the IdP.
	e.app.Sessions.Wait()
	if got := e.idp.Revoked(); len(got) != 1 {
		t.Fatalf("revoked at IdP = %d tokens, want the previous user's", len(got))
	}
}

func TestSignInAgainAfterTheOldSessionWasRevoked(t *testing.T) {
	e := newEnv(t)
	cl, c := e.signedIn(t)
	before := currentSessionID(t, cl)
	if _, err := e.store.Pool().Exec(context.Background(),
		`UPDATE user_sessions SET revoked_at = now() WHERE id = $1`, before); err != nil {
		t.Fatal(err)
	}

	e.mustSignIn(t, c)
	if _, err := getSelf(t, cl); err != nil {
		t.Fatalf("the new session does not work: %v", err)
	}
	if n := len(listSessions(t, cl)); n != 1 {
		t.Fatalf("sessions = %d, want only the new one", n)
	}
	e.app.Sessions.Wait()
	if got := e.idp.Revoked(); len(got) != 0 {
		t.Fatalf("revoked at IdP = %d tokens, want none", len(got))
	}
	if strings.Contains(e.logs.String(), "revoking the replaced session failed") {
		t.Fatal("an already revoked session was reported as a failure")
	}
}
