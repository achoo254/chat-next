package api_test

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/api"
	"app.local/server/internal/auth/idptest"
	"app.local/server/internal/config"
	"app.local/server/internal/store"
	"app.local/server/internal/store/testdb"
	"connectrpc.com/connect"
)

const (
	clientID     = "chat-web"
	clientSecret = "test-client-secret"
	tenantID     = "primary"
)

func TestMain(m *testing.M) {
	os.Exit(testdb.Main(m))
}

// env is one chat server (TLS, so Secure cookies flow) wired to a fake IdP
// and a fresh database.
type env struct {
	srv   *httptest.Server
	idp   *idptest.Provider
	app   *api.App
	store *store.Store
}

func newEnv(t *testing.T) *env {
	t.Helper()
	ctx := context.Background()
	st := testdb.Open(t)
	if err := st.EnsureTenant(ctx, tenantID, "hoandat.com", "hoandat.com"); err != nil {
		t.Fatal(err)
	}
	idp := idptest.New(t, clientID, clientSecret)
	srv := httptest.NewUnstartedServer(nil)
	srv.StartTLS()
	t.Cleanup(srv.Close)
	public, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{
		Env:              config.EnvProduction,
		ListenAddr:       config.DefaultListenAddr,
		PublicURL:        public,
		OIDCIssuer:       idp.Issuer(),
		OIDCClientID:     clientID,
		OIDCClientSecret: clientSecret,
		SessionKey:       bytes.Repeat([]byte{42}, 32),
		TenantID:         tenantID,
		TenantDomain:     "hoandat.com",
	}
	logger := slog.New(slog.NewTextHandler(t.Output(), nil))
	app, err := api.New(cfg, st, idp.Server.Client(), logger)
	if err != nil {
		t.Fatal(err)
	}
	// Background IdP work must finish before the store closes.
	t.Cleanup(app.Sessions.Wait)
	if err := app.IdP.Discover(ctx); err != nil {
		t.Fatal(err)
	}
	srv.Config.Handler = app.Handler
	return &env{srv: srv, idp: idp, app: app, store: st}
}

// browser returns an HTTP client with its own cookie jar that trusts the
// test server's certificate and follows redirects.
func (e *env) browser(t *testing.T) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	// srv.Client() is shared; copy its TLS-trusting transport only.
	return &http.Client{Transport: e.srv.Client().Transport, Jar: jar}
}

// noRedirect returns a copy of c that stops at the first redirect.
func noRedirect(c *http.Client) *http.Client {
	cp := *c
	cp.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &cp
}

func readBody(t *testing.T, resp *http.Response) string {
	t.Helper()
	defer func() { _ = resp.Body.Close() }()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// signIn runs the whole web sign-in with the fake IdP's current account and
// returns the final (callback) response body.
func (e *env) signIn(t *testing.T, c *http.Client, query string) (*http.Response, string) {
	t.Helper()
	resp, err := c.Get(e.srv.URL + "/auth/login" + query)
	if err != nil {
		t.Fatal(err)
	}
	return resp, readBody(t, resp)
}

func (e *env) mustSignIn(t *testing.T, c *http.Client) {
	t.Helper()
	resp, body := e.signIn(t, c, "?locale=vi")
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, `http-equiv="refresh"`) {
		t.Fatalf("sign-in: status %d body %q", resp.StatusCode, body)
	}
}

func (e *env) cookie(t *testing.T, c *http.Client, name string) *http.Cookie {
	t.Helper()
	u, _ := url.Parse(e.srv.URL)
	for _, ck := range c.Jar.Cookies(u) {
		if ck.Name == name {
			return ck
		}
	}
	return nil
}

// withOrigin sets the Origin header of every client call.
func withOrigin(origin string) connect.ClientOption {
	return connect.WithInterceptors(connect.UnaryInterceptorFunc(func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
			if origin != "" {
				req.Header().Set("Origin", origin)
			}
			return next(ctx, req)
		}
	}))
}

type clients struct {
	auth   appv1connect.AuthServiceClient
	users  appv1connect.UsersServiceClient
	config appv1connect.ConfigServiceClient
}

func (e *env) rpc(c *http.Client, origin string) clients {
	base := e.srv.URL + "/rpc"
	opt := withOrigin(origin)
	return clients{
		auth:   appv1connect.NewAuthServiceClient(c, base, opt),
		users:  appv1connect.NewUsersServiceClient(c, base, opt),
		config: appv1connect.NewConfigServiceClient(c, base, opt),
	}
}

// signedIn returns RPC clients for a browser signed in as the IdP's current
// account, sending the server's own origin.
func (e *env) signedIn(t *testing.T) (clients, *http.Client) {
	t.Helper()
	c := e.browser(t)
	e.mustSignIn(t, c)
	return e.rpc(c, e.srv.URL), c
}

func codeOf(err error) connect.Code {
	var ce *connect.Error
	if errors.As(err, &ce) {
		return ce.Code()
	}
	return connect.CodeUnknown
}

func getSelf(t *testing.T, cl clients) (*appv1.User, error) {
	t.Helper()
	resp, err := cl.users.GetSelf(context.Background(), connect.NewRequest(&appv1.GetSelfRequest{}))
	if err != nil {
		return nil, err
	}
	return resp.Msg.GetUser(), nil
}

// currentSessionID returns the id of the session the clients use.
func currentSessionID(t *testing.T, cl clients) int64 {
	t.Helper()
	resp, err := cl.auth.ListSessions(context.Background(), connect.NewRequest(&appv1.ListSessionsRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range resp.Msg.GetSessions() {
		if s.GetCurrent() {
			return s.GetId()
		}
	}
	t.Fatal("no current session")
	return 0
}

// makeGrantDue backdates the session's last grant check by two hours.
func (e *env) makeGrantDue(t *testing.T, sessionID int64) {
	t.Helper()
	ran, err := e.store.CheckGrant(context.Background(), sessionID, -48*time.Hour,
		func(context.Context, store.GrantCandidate) store.GrantOutcome {
			return store.GrantOutcome{Result: store.GrantRetry, RetryAfter: -50 * time.Hour}
		})
	if err != nil || !ran {
		t.Fatalf("makeGrantDue: %v, %v", ran, err)
	}
}

// postLogoutToken posts a back-channel logout like the IdP does: no
// cookies, no Origin.
func postLogoutToken(t *testing.T, e *env, token string) int {
	t.Helper()
	resp, err := e.srv.Client().PostForm(e.srv.URL+"/auth/backchannel-logout", url.Values{"logout_token": {token}})
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	return resp.StatusCode
}
