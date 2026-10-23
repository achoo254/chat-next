package api_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/api"
	"app.local/server/internal/auth"
	"app.local/server/internal/auth/idptest"
	"app.local/server/internal/config"
	"connectrpc.com/connect"
	"github.com/coder/websocket"
	"golang.org/x/oauth2"
	"google.golang.org/protobuf/proto"
)

const (
	appScheme      = "com.hoandat.chat"
	mobileRedirect = appScheme + ":/auth/callback"
)

// newNativeEnv is newEnv with the app scheme configured and chat-mobile
// registered at the fake IdP as a public client.
func newNativeEnv(t *testing.T) *env {
	t.Helper()
	e := newEnv(t, func(c *config.Config, _ *api.Options) { c.AppURLScheme = appScheme })
	e.idp.AllowPublicClient(auth.MobileClientID)
	return e
}

// withHeaders sets fixed headers on every client call.
func withHeaders(h map[string]string) connect.ClientOption {
	return connect.WithInterceptors(connect.UnaryInterceptorFunc(func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
			for k, v := range h {
				req.Header().Set(k, v)
			}
			return next(ctx, req)
		}
	}))
}

// nativeRPC returns clients that call like the app's WebView: from origin,
// with the bearer token when it is not empty, and without cookies.
func (e *env) nativeRPC(origin, token string) (clients, appv1connect.ChatsServiceClient) {
	h := map[string]string{"Origin": origin}
	if token != "" {
		h["Authorization"] = "Bearer " + token
	}
	c := &http.Client{Transport: e.srv.Client().Transport}
	base := e.srv.URL + "/rpc"
	opt := withHeaders(h)
	return clients{
		auth:   appv1connect.NewAuthServiceClient(c, base, opt),
		users:  appv1connect.NewUsersServiceClient(c, base, opt),
		config: appv1connect.NewConfigServiceClient(c, base, opt),
	}, appv1connect.NewChatsServiceClient(c, base, opt)
}

// nativeCode runs what the app does in the system browser: GetAuthConfig,
// the authorization request with PKCE, and the callback. It returns the
// code and verifier.
func (e *env) nativeCode(t *testing.T, extra url.Values) (code, verifier string) {
	t.Helper()
	anon, _ := e.nativeRPC(auth.NativeOriginIOS, "")
	cfg, err := anon.auth.GetAuthConfig(context.Background(), connect.NewRequest(&appv1.GetAuthConfigRequest{
		Platform: appv1.ClientPlatform_CLIENT_PLATFORM_IOS,
	}))
	if err != nil {
		t.Fatal(err)
	}
	verifier = oauth2.GenerateVerifier()
	sum := sha256.Sum256([]byte(verifier))
	q := url.Values{
		"client_id": {cfg.Msg.GetClientId()}, "redirect_uri": {cfg.Msg.GetRedirectUri()}, "response_type": {"code"},
		"scope": {strings.Join(cfg.Msg.GetScopes(), " ")}, "state": {"state-1"},
		"code_challenge": {base64.RawURLEncoding.EncodeToString(sum[:])}, "code_challenge_method": {"S256"},
	}
	for k, v := range extra {
		q[k] = v
	}
	resp, err := noRedirect(e.idp.Server.Client()).Get(cfg.Msg.GetAuthorizationEndpoint() + "?" + q.Encode())
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	back, err := url.Parse(resp.Header.Get("Location"))
	if err != nil || back.Scheme != appScheme || back.Query().Get("state") != "state-1" {
		t.Fatalf("authorize answered %d, callback %v (%v)", resp.StatusCode, back, err)
	}
	return back.Query().Get("code"), verifier
}

// nativeSignIn signs the IdP's current account in like the app and returns
// the session token.
func (e *env) nativeSignIn(t *testing.T, bearer string) *appv1.ExchangeNativeCodeResponse {
	t.Helper()
	code, verifier := e.nativeCode(t, nil)
	cl, _ := e.nativeRPC(auth.NativeOriginIOS, bearer)
	resp, err := cl.auth.ExchangeNativeCode(context.Background(), connect.NewRequest(&appv1.ExchangeNativeCodeRequest{
		Code: code, CodeVerifier: verifier, RedirectUri: mobileRedirect,
		Platform: appv1.ClientPlatform_CLIENT_PLATFORM_IOS, DeviceName: "iPhone của An", AppVersion: "1.0.0 (7)",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Msg.GetSessionToken()) < 40 || resp.Msg.GetSessionId() == 0 || resp.Msg.GetUser().GetId() == 0 {
		t.Fatalf("exchange = %v", resp.Msg)
	}
	return resp.Msg
}

func TestNativeAuthConfig(t *testing.T) {
	e := newNativeEnv(t)
	ctx := context.Background()
	cl, _ := e.nativeRPC(auth.NativeOriginAndroid, "")
	mobile, err := cl.auth.GetAuthConfig(ctx, connect.NewRequest(&appv1.GetAuthConfigRequest{Platform: appv1.ClientPlatform_CLIENT_PLATFORM_ANDROID}))
	if err != nil {
		t.Fatal(err)
	}
	m := mobile.Msg
	if m.GetClientId() != auth.MobileClientID || m.GetRedirectUri() != mobileRedirect ||
		m.GetAuthorizationEndpoint() != e.idp.Issuer()+"/authorize" || m.GetIssuer() != e.idp.Issuer() ||
		strings.Join(m.GetScopes(), " ") != "openid profile email" || m.GetTenantName() != "hoandat.com" {
		t.Fatalf("mobile config = %v", m)
	}
	web, err := e.rpc(e.browser(t), e.srv.URL).auth.GetAuthConfig(ctx, connect.NewRequest(&appv1.GetAuthConfigRequest{Platform: appv1.ClientPlatform_CLIENT_PLATFORM_WEB}))
	if err != nil || web.Msg.GetClientId() != clientID || web.Msg.GetRedirectUri() != "" {
		t.Fatalf("web config = %v, %v", web, err)
	}
	// Only the tenant's own origin and the two WebView origins pass.
	for _, origin := range []string{"https://evil.example", "capacitor://evil", "http://localhost", ""} {
		bad, _ := e.nativeRPC(origin, "")
		if _, err := bad.auth.GetAuthConfig(ctx, connect.NewRequest(&appv1.GetAuthConfigRequest{})); codeOf(err) != connect.CodePermissionDenied {
			t.Errorf("origin %q: err %v, want permission_denied", origin, err)
		}
	}
}

func TestNativeSignInAndBearer(t *testing.T) {
	e := newNativeEnv(t)
	ctx := context.Background()
	out := e.nativeSignIn(t, "")
	if out.GetUser().GetUsername() != "tester" || !out.GetUser().GetIsSelf() {
		t.Fatalf("user = %v", out.GetUser())
	}
	// The ID token was checked for aud chat-mobile and the refresh token
	// kept for the device's grant.
	cl, chats := e.nativeRPC(auth.NativeOriginIOS, out.GetSessionToken())
	self, err := getSelf(t, cl)
	if err != nil || self.GetId() != out.GetUser().GetId() {
		t.Fatalf("GetSelf with bearer = %v, %v", self, err)
	}
	if _, err := chats.GetDialogs(ctx, connect.NewRequest(&appv1.GetDialogsRequest{Limit: 10})); err != nil {
		t.Fatalf("GetDialogs with bearer: %v", err)
	}
	list, err := cl.auth.ListSessions(ctx, connect.NewRequest(&appv1.ListSessionsRequest{}))
	if err != nil || len(list.Msg.GetSessions()) != 1 {
		t.Fatalf("ListSessions = %v, %v", list, err)
	}
	s := list.Msg.GetSessions()[0]
	if s.GetPlatform() != appv1.ClientPlatform_CLIENT_PLATFORM_IOS || s.GetDeviceName() != "iPhone của An" ||
		s.GetAppVersion() != "1.0.0 (7)" || !s.GetCurrent() || s.GetId() != out.GetSessionId() {
		t.Fatalf("native session = %v", s)
	}
	// The bearer works from the Android origin and the tenant's own origin
	// too (a cross-site page cannot attach it).
	for _, origin := range []string{auth.NativeOriginAndroid, e.srv.URL} {
		other, _ := e.nativeRPC(origin, out.GetSessionToken())
		if _, err := getSelf(t, other); err != nil {
			t.Errorf("bearer from %s: %v", origin, err)
		}
	}
	// A web session's cookie is never accepted from a WebView origin, and
	// its token is never accepted as a bearer token.
	web, browser := e.signedIn(t)
	if _, err := getSelf(t, web); err != nil {
		t.Fatal(err)
	}
	cookie := e.cookie(t, browser, auth.SessionCookieName)
	cookieFromApp := e.rpc(browser, auth.NativeOriginIOS)
	if _, err := getSelf(t, cookieFromApp); codeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("cookie from a native origin: %v, want unauthenticated", err)
	}
	webAsBearer, _ := e.nativeRPC(auth.NativeOriginIOS, cookie.Value)
	if _, err := getSelf(t, webAsBearer); codeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("web token as bearer: %v, want unauthenticated", err)
	}
	unknown, _ := e.nativeRPC(auth.NativeOriginIOS, "not-a-token")
	if _, err := getSelf(t, unknown); codeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("unknown bearer: %v", err)
	}

	// Sign-out with the bearer revokes the session and its refresh token at
	// the IdP, authenticating as the public client.
	if _, err := cl.auth.SignOut(ctx, connect.NewRequest(&appv1.SignOutRequest{})); err != nil {
		t.Fatal(err)
	}
	if _, err := getSelf(t, cl); codeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("after sign-out: %v", err)
	}
	e.app.Sessions.Wait()
	if got := e.idp.Revoked(); len(got) != 1 || !strings.HasPrefix(got[0], "rt-") {
		t.Fatalf("revoked at IdP = %v", got)
	}
}

func TestNativeExchangeRejects(t *testing.T) {
	e := newNativeEnv(t)
	ctx := context.Background()
	cl, _ := e.nativeRPC(auth.NativeOriginIOS, "")
	exchange := func(m *appv1.ExchangeNativeCodeRequest) error {
		_, err := cl.auth.ExchangeNativeCode(ctx, connect.NewRequest(m))
		return err
	}
	code, verifier := e.nativeCode(t, nil)
	valid := func() *appv1.ExchangeNativeCodeRequest {
		return &appv1.ExchangeNativeCodeRequest{Code: code, CodeVerifier: verifier, RedirectUri: mobileRedirect,
			Platform: appv1.ClientPlatform_CLIENT_PLATFORM_ANDROID}
	}
	cases := map[string]func(*appv1.ExchangeNativeCodeRequest){
		"web platform":     func(m *appv1.ExchangeNativeCodeRequest) { m.Platform = appv1.ClientPlatform_CLIENT_PLATFORM_WEB },
		"no code":          func(m *appv1.ExchangeNativeCodeRequest) { m.Code = "" },
		"short verifier":   func(m *appv1.ExchangeNativeCodeRequest) { m.CodeVerifier = "abc" },
		"other redirect":   func(m *appv1.ExchangeNativeCodeRequest) { m.RedirectUri = "com.evil.app:/auth/callback" },
		"wrong verifier":   func(m *appv1.ExchangeNativeCodeRequest) { m.CodeVerifier = oauth2.GenerateVerifier() },
		"verifier charset": func(m *appv1.ExchangeNativeCodeRequest) { m.CodeVerifier = strings.Repeat("a", 42) + "=" },
	}
	for name, mutate := range cases {
		m := valid()
		mutate(m)
		if err := exchange(m); codeOf(err) != connect.CodeInvalidArgument {
			t.Errorf("%s: err %v, want invalid_argument", name, err)
		}
	}
	// The wrong verifier spent the code at the IdP: the right one fails too,
	// as would any replay.
	if err := exchange(valid()); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("spent code: %v", err)
	}
	// A code issued to the web client cannot be redeemed as chat-mobile.
	code, verifier = e.nativeCode(t, url.Values{"client_id": {clientID}})
	if err := exchange(&appv1.ExchangeNativeCodeRequest{Code: code, CodeVerifier: verifier, RedirectUri: mobileRedirect,
		Platform: appv1.ClientPlatform_CLIENT_PLATFORM_IOS}); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("web client's code: %v", err)
	}
}

func TestNativeSignInAgainReplacesSession(t *testing.T) {
	e := newNativeEnv(t)
	first := e.nativeSignIn(t, "")
	second := e.nativeSignIn(t, first.GetSessionToken())
	old, _ := e.nativeRPC(auth.NativeOriginIOS, first.GetSessionToken())
	if _, err := getSelf(t, old); codeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("replaced session still works: %v", err)
	}
	cl, _ := e.nativeRPC(auth.NativeOriginIOS, second.GetSessionToken())
	list, err := cl.auth.ListSessions(context.Background(), connect.NewRequest(&appv1.ListSessionsRequest{}))
	if err != nil || len(list.Msg.GetSessions()) != 1 {
		t.Fatalf("sessions after signing in again = %v, %v", list, err)
	}
	// Another user's bearer is never replaced.
	e.idp.SetAccount(idptest.Account{Sub: "acc_other", SID: "sid-other", PreferredUsername: "other"})
	third := e.nativeSignIn(t, second.GetSessionToken())
	if _, err := getSelf(t, cl); err != nil {
		t.Fatalf("another account's sign-in ended this session: %v", err)
	}
	if third.GetUser().GetId() == second.GetUser().GetId() {
		t.Fatal("same user")
	}
}

func TestNativeGrantCheck(t *testing.T) {
	e := newNativeEnv(t)
	ctx := context.Background()
	out := e.nativeSignIn(t, "")
	cl, _ := e.nativeRPC(auth.NativeOriginIOS, out.GetSessionToken())

	// Refresh as the public client rotates the token and keeps the session.
	e.makeGrantDue(t, out.GetSessionId())
	if ran, err := e.app.Sessions.CheckGrant(ctx, out.GetSessionId()); !ran || err != nil {
		t.Fatalf("CheckGrant = %v, %v", ran, err)
	}
	if e.idp.RefreshCalls() != 1 {
		t.Fatalf("refresh calls = %d", e.idp.RefreshCalls())
	}
	if _, err := getSelf(t, cl); err != nil {
		t.Fatalf("after refresh: %v", err)
	}
	// invalid_grant (the device was removed at the IdP) ends the session.
	e.idp.SetRefresh(idptest.RefreshInvalidGrant, 0)
	e.makeGrantDue(t, out.GetSessionId())
	if ran, err := e.app.Sessions.CheckGrant(ctx, out.GetSessionId()); !ran || err != nil {
		t.Fatalf("CheckGrant = %v, %v", ran, err)
	}
	if _, err := getSelf(t, cl); codeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("after invalid_grant: %v", err)
	}
}

func TestNativeCORS(t *testing.T) {
	e := newNativeEnv(t)
	preflight := func(origin string) *http.Response {
		req, err := http.NewRequestWithContext(context.Background(), http.MethodOptions, e.srv.URL+"/rpc/app.v1.UsersService/GetSelf", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Origin", origin)
		req.Header.Set("Access-Control-Request-Method", "POST")
		req.Header.Set("Access-Control-Request-Headers", "authorization, content-type, connect-protocol-version")
		resp, err := e.srv.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		return resp
	}
	for _, origin := range []string{auth.NativeOriginIOS, auth.NativeOriginAndroid} {
		resp := preflight(origin)
		h := resp.Header
		if resp.StatusCode != http.StatusNoContent || h.Get("Access-Control-Allow-Origin") != origin ||
			!strings.Contains(h.Get("Access-Control-Allow-Headers"), "Authorization") ||
			!strings.Contains(h.Get("Access-Control-Allow-Methods"), "POST") ||
			h.Get("Access-Control-Allow-Credentials") != "" {
			t.Errorf("preflight from %s: %d %v", origin, resp.StatusCode, h)
		}
	}
	for _, origin := range []string{"https://evil.example", e.srv.URL} {
		if resp := preflight(origin); resp.Header.Get("Access-Control-Allow-Origin") != "" {
			t.Errorf("preflight from %s allowed: %v", origin, resp.Header)
		}
	}
	// Answers to the app carry its origin, never credentials.
	out := e.nativeSignIn(t, "")
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, e.srv.URL+"/rpc/app.v1.UsersService/GetSelf", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Origin", auth.NativeOriginIOS)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+out.GetSessionToken())
	resp, err := e.srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body := readBody(t, resp)
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Access-Control-Allow-Origin") != auth.NativeOriginIOS ||
		resp.Header.Get("Access-Control-Allow-Credentials") != "" || !strings.Contains(body, `"username":"tester"`) {
		t.Fatalf("GetSelf from the app: %d %v %s", resp.StatusCode, resp.Header, body)
	}
}

// dialNative opens a socket like the app's WebView (no cookie) and sends
// hello with token.
func (e *env) dialNative(t *testing.T, origin, token string, cookie *http.Cookie) *socket {
	t.Helper()
	u, _ := url.Parse(e.srv.URL)
	header := http.Header{}
	header.Set("Origin", origin)
	if cookie != nil {
		header.Set("Cookie", cookie.Name+"="+cookie.Value)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "wss://"+u.Host+"/ws", &websocket.DialOptions{
		HTTPClient: &http.Client{Transport: e.srv.Client().Transport}, HTTPHeader: header,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ws.CloseNow() })
	s := &socket{ws: ws, frames: make(chan *appv1.ServerFrame, 1024)}
	s.send(t, &appv1.ClientFrame{Frame: &appv1.ClientFrame_Hello{Hello: &appv1.ClientHelloFrame{
		SessionToken: token, Platform: appv1.ClientPlatform_CLIENT_PLATFORM_IOS, AppVersion: "1.0.0",
	}}})
	go func() {
		defer close(s.frames)
		for {
			_, data, err := ws.Read(context.Background())
			if err != nil {
				return
			}
			f := &appv1.ServerFrame{}
			if proto.Unmarshal(data, f) == nil {
				s.frames <- f
			}
		}
	}()
	return s
}

// closed waits for the socket to end.
func (s *socket) closed(t *testing.T) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case _, ok := <-s.frames:
			if !ok {
				return
			}
		case <-deadline:
			t.Fatal("socket still open after 5s")
		}
	}
}

func TestNativeRealtime(t *testing.T) {
	e := newNativeEnv(t)
	out := e.nativeSignIn(t, "")
	ws := e.dialNative(t, auth.NativeOriginIOS, out.GetSessionToken(), nil)
	f := ws.reply(t)
	if f.GetHello().GetUserId() != out.GetUser().GetId() || f.GetHello().GetSessionId() != out.GetSessionId() {
		t.Fatalf("hello = %v", f)
	}

	// Without a valid hello token the socket is refused with UNAUTHENTICATED,
	// and a web cookie from a WebView origin does not count.
	_, browser := e.signedIn(t)
	cookie := e.cookie(t, browser, auth.SessionCookieName)
	for name, token := range map[string]string{"no token": "", "unknown token": "nope", "web token": cookie.Value} {
		bad := e.dialNative(t, auth.NativeOriginAndroid, token, cookie)
		if f := bad.reply(t); f.GetError().GetCode() != appv1.FrameErrorCode_FRAME_ERROR_CODE_UNAUTHENTICATED {
			t.Errorf("%s: first frame %v", name, f)
		}
		bad.closed(t)
	}

	// Revoking the native session (here: from the web session of the same
	// user) closes its socket with SessionRevoked.
	web := e.rpc(browser, e.srv.URL)
	if _, err := web.auth.RevokeSession(context.Background(), connect.NewRequest(&appv1.RevokeSessionRequest{SessionId: out.GetSessionId()})); err != nil {
		t.Fatal(err)
	}
	// How fast is TestRealtimeEndToEnd's business; on a loaded machine the
	// outbox may hold the update behind a gap for a while.
	deadline := time.After(40 * time.Second)
	for revoked := false; !revoked; {
		select {
		case f, ok := <-ws.frames:
			if !ok {
				t.Fatal("socket closed without SessionRevokedFrame")
			}
			if r := f.GetSessionRevoked(); r != nil {
				if r.GetReason() != appv1.SessionRevokeReason_SESSION_REVOKE_REASON_REVOKED_BY_USER {
					t.Fatalf("reason = %v", r.GetReason())
				}
				revoked = true
			}
		case <-deadline:
			t.Fatal("no SessionRevokedFrame within 40s")
		}
	}
	ws.closed(t)
}

func TestNativeBackchannelLogout(t *testing.T) {
	e := newNativeEnv(t)
	// The fake IdP signs the app in under the same IdP session (sid-1) as the
	// browser, as a non-ephemeral system browser session does.
	web, _ := e.signedIn(t)
	out := e.nativeSignIn(t, "")
	app, _ := e.nativeRPC(auth.NativeOriginIOS, out.GetSessionToken())

	// The browser's IdP session ending (web token with sid) signs the web
	// out and leaves the app's per-device grant alone.
	if code := postLogoutToken(t, e, e.idp.LogoutToken(t, e.idp.LogoutClaims("sid-1"))); code != http.StatusOK {
		t.Fatalf("web logout status %d", code)
	}
	if _, err := getSelf(t, web); codeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("web session after logout: %v", err)
	}
	if _, err := getSelf(t, app); err != nil {
		t.Fatalf("app session ended by the browser's logout: %v", err)
	}
	// A logout token for chat-mobile ends the app's session of that sid.
	mobile := e.idp.LogoutClaims("sid-1")
	mobile["aud"] = auth.MobileClientID
	if code := postLogoutToken(t, e, e.idp.LogoutToken(t, mobile)); code != http.StatusOK {
		t.Fatalf("native logout status %d", code)
	}
	if _, err := getSelf(t, app); codeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("app session after chat-mobile logout: %v", err)
	}
	// A subject-wide token (no sid) ends every session, the app's included.
	again := e.nativeSignIn(t, "")
	app, _ = e.nativeRPC(auth.NativeOriginIOS, again.GetSessionToken())
	all := e.idp.LogoutClaims("")
	delete(all, "sid")
	if code := postLogoutToken(t, e, e.idp.LogoutToken(t, all)); code != http.StatusOK {
		t.Fatalf("subject logout status %d", code)
	}
	if _, err := getSelf(t, app); codeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("app session after subject logout: %v", err)
	}
}

func TestNativeSignInCanBeTurnedOff(t *testing.T) {
	e := newEnv(t, func(c *config.Config, _ *api.Options) { c.AppURLScheme, c.NativeSignInOff = appScheme, true })
	cl, _ := e.nativeRPC(auth.NativeOriginIOS, "")
	ctx := context.Background()
	if _, err := cl.auth.GetAuthConfig(ctx, connect.NewRequest(&appv1.GetAuthConfigRequest{Platform: appv1.ClientPlatform_CLIENT_PLATFORM_IOS})); codeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("GetAuthConfig with native sign-in off: %v", err)
	}
	_, err := cl.auth.ExchangeNativeCode(ctx, connect.NewRequest(&appv1.ExchangeNativeCodeRequest{
		Code: "c", CodeVerifier: oauth2.GenerateVerifier(), RedirectUri: mobileRedirect, Platform: appv1.ClientPlatform_CLIENT_PLATFORM_IOS,
	}))
	if codeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("ExchangeNativeCode with native sign-in off: %v", err)
	}
	// The web is unaffected.
	if _, err := e.rpc(e.browser(t), e.srv.URL).auth.GetAuthConfig(ctx, connect.NewRequest(&appv1.GetAuthConfigRequest{})); err != nil {
		t.Fatal(err)
	}
}
