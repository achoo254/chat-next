// Package idptest is a fake OpenID Connect provider for tests, shaped like
// hoandat-auth for the chat-web client: discovery, an ES256 JWKS, an
// authorize endpoint that immediately redirects back with a code, a token
// endpoint (authorization_code with PKCE S256 and client_secret_basic, and
// rotating single-use refresh tokens), revocation, end_session and userinfo.
// It also signs back-channel logout tokens.
//
// Like hoandat-auth, ID tokens carry preferred_username but not the name and
// email claims, which only the userinfo endpoint returns.
//
// Serve runs the same provider outside a test, on a fixed address, with a
// page to pick which of several accounts signs in: the local multi-user
// end-to-end stack (cmd/e2e-stack) uses it so several browsers sign in as
// different people through the real OIDC code path.
package idptest

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
)

// RefreshMode selects how the token endpoint answers refresh requests.
type RefreshMode int

// Refresh modes.
const (
	RefreshOK RefreshMode = iota
	RefreshInvalidGrant
	RefreshServerError
	// RefreshInvalidClient answers 401 invalid_client.
	RefreshInvalidClient
	// RefreshBadIDToken rotates the refresh token normally but returns an ID
	// token signed by a key that is not in the JWKS.
	RefreshBadIDToken
)

// UserInfoMode selects how the userinfo endpoint answers.
type UserInfoMode int

// Userinfo modes.
const (
	UserInfoOK UserInfoMode = iota
	// UserInfoServerError answers 500.
	UserInfoServerError
	// UserInfoOtherSubject answers for another subject than the token's.
	UserInfoOtherSubject
)

// Account is the user the provider signs in.
type Account struct {
	Sub               string
	SID               string
	PreferredUsername string
	Name              string
	Email             string
	EmailVerified     bool
}

// Authorize records one authorization request.
type Authorize struct {
	Query url.Values
}

type codeGrant struct {
	challenge string
	nonce     string
	redirect  string
	account   Account
	// authTime: the request carried max_age, so the ID token states
	// auth_time (as oidc-provider does); the fake IdP always authenticates
	// at the authorize request.
	authTime time.Time
}

// Provider is a running fake IdP.
type Provider struct {
	Server       *httptest.Server
	ClientID     string
	ClientSecret string

	key *ecdsa.PrivateKey
	kid string

	mu            sync.Mutex
	account       Account
	nonceOverride *string
	refreshMode   RefreshMode
	refreshDelay  time.Duration
	refreshCalls  int
	refreshGate   chan struct{}   // non-nil: refresh grants wait for it to close
	refreshArrive chan struct{}   // receives one value per gated refresh grant
	refreshTokens map[string]bool // issued token -> still valid
	userInfoMode  UserInfoMode
	// accounts is the picker's list (Serve only); nil means the provider
	// always signs in account.
	accounts     []Account
	tokenAccount map[string]Account // refresh token -> account it was issued to
	accessTokens map[string]Account // access token -> account it was issued to
	codes        map[string]codeGrant
	authorizes   []Authorize
	revoked      []string
}

// New starts a provider for the given client; it stops with the test.
func New(t testing.TB, clientID, clientSecret string) *Provider {
	t.Helper()
	p, err := newProvider(clientID, clientSecret)
	if err != nil {
		t.Fatal(err)
	}
	p.Server = httptest.NewServer(p.routes())
	t.Cleanup(p.Server.Close)
	return p
}

// Serve starts a provider listening on addr whose authorize endpoint shows
// a page to pick one of accounts; each refresh token keeps the account it
// was issued to. Close it with p.Server.Close.
func Serve(addr, clientID, clientSecret string, accounts []Account) (*Provider, error) {
	if len(accounts) == 0 {
		return nil, errors.New("idptest: Serve needs at least one account")
	}
	p, err := newProvider(clientID, clientSecret)
	if err != nil {
		return nil, err
	}
	p.accounts = append([]Account(nil), accounts...)
	p.account = accounts[0]
	l, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	p.Server = httptest.NewUnstartedServer(p.routes())
	_ = p.Server.Listener.Close()
	p.Server.Listener = l
	p.Server.Start()
	return p, nil
}

func newProvider(clientID, clientSecret string) (*Provider, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	return &Provider{
		ClientID: clientID, ClientSecret: clientSecret,
		key: key, kid: "test-key-1",
		account: Account{
			Sub: "acc_test", SID: "sid-1", PreferredUsername: "tester", Name: "Người Thử",
			Email: "tester@example.com", EmailVerified: true,
		},
		refreshTokens: map[string]bool{},
		tokenAccount:  map[string]Account{},
		accessTokens:  map[string]Account{},
		codes:         map[string]codeGrant{},
	}, nil
}

func (p *Provider) routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /.well-known/openid-configuration", p.discovery)
	mux.HandleFunc("GET /jwks", p.jwks)
	mux.HandleFunc("GET /authorize", p.authorize)
	mux.HandleFunc("POST /token", p.token)
	mux.HandleFunc("POST /revoke", p.revoke)
	mux.HandleFunc("GET /session/end", p.endSession)
	mux.HandleFunc("GET /me", p.userinfo)
	return mux
}

// endSession answers the RP-initiated logout; with the picker it sends the
// browser back to post_logout_redirect_uri like the real IdP.
func (p *Provider) endSession(w http.ResponseWriter, r *http.Request) {
	if back := r.URL.Query().Get("post_logout_redirect_uri"); p.accounts != nil && back != "" {
		http.Redirect(w, r, back, http.StatusFound)
		return
	}
	w.WriteHeader(http.StatusOK)
}

// Issuer is the provider's issuer URL.
func (p *Provider) Issuer() string { return p.Server.URL }

// SetAccount changes the user signed in by the next authorization.
func (p *Provider) SetAccount(a Account) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.account = a
}

// SetNonceOverride makes ID tokens carry nonce instead of the requested one.
func (p *Provider) SetNonceOverride(nonce string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.nonceOverride = &nonce
}

// SetRefresh selects the refresh behaviour and an artificial delay.
func (p *Provider) SetRefresh(mode RefreshMode, delay time.Duration) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.refreshMode, p.refreshDelay = mode, delay
}

// HoldRefresh makes refresh grants wait, after they are counted and before
// any token is checked or issued, until release is called. arrived receives
// one value per held grant. release is also called when the test ends.
func (p *Provider) HoldRefresh(t testing.TB) (arrived <-chan struct{}, release func()) {
	t.Helper()
	gate, arrive := make(chan struct{}), make(chan struct{}, 64)
	p.mu.Lock()
	p.refreshGate, p.refreshArrive = gate, arrive
	p.mu.Unlock()
	var once sync.Once
	release = func() {
		once.Do(func() {
			p.mu.Lock()
			p.refreshGate, p.refreshArrive = nil, nil
			p.mu.Unlock()
			close(gate)
		})
	}
	t.Cleanup(release)
	return arrive, release
}

// SetUserInfo selects how the userinfo endpoint answers.
func (p *Provider) SetUserInfo(mode UserInfoMode) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.userInfoMode = mode
}

// RefreshCalls is the number of refresh_token grants received.
func (p *Provider) RefreshCalls() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.refreshCalls
}

// Revoked returns the tokens posted to the revocation endpoint.
func (p *Provider) Revoked() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.revoked...)
}

// Authorizes returns the authorization requests received.
func (p *Provider) Authorizes() []Authorize {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]Authorize(nil), p.authorizes...)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (p *Provider) discovery(w http.ResponseWriter, _ *http.Request) {
	iss := p.Issuer()
	writeJSON(w, http.StatusOK, map[string]any{
		"issuer":                                iss,
		"authorization_endpoint":                iss + "/authorize",
		"token_endpoint":                        iss + "/token",
		"jwks_uri":                              iss + "/jwks",
		"userinfo_endpoint":                     iss + "/me",
		"revocation_endpoint":                   iss + "/revoke",
		"end_session_endpoint":                  iss + "/session/end",
		"id_token_signing_alg_values_supported": []string{"ES256", "RS256"},
		"prompt_values_supported":               []string{"none", "create", "login", "consent"},
		"ui_locales_supported":                  []string{"en", "zh-CN", "vi"},
	})
}

func (p *Provider) jwks(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{
		Key: &p.key.PublicKey, KeyID: p.kid, Algorithm: string(jose.ES256), Use: "sig",
	}}})
}

func randomString() string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func (p *Provider) authorize(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	p.mu.Lock()
	p.authorizes = append(p.authorizes, Authorize{Query: q})
	p.mu.Unlock()
	if q.Get("client_id") != p.ClientID || q.Get("response_type") != "code" ||
		q.Get("code_challenge_method") != "S256" || q.Get("code_challenge") == "" || q.Get("redirect_uri") == "" {
		http.Error(w, "invalid authorization request", http.StatusBadRequest)
		return
	}
	p.mu.Lock()
	account, accounts := p.account, p.accounts
	p.mu.Unlock()
	if accounts != nil {
		picked, ok := pickAccount(accounts, q.Get("account"))
		if !ok {
			renderPicker(w, q, accounts)
			return
		}
		account = picked
	}
	code := randomString()
	p.mu.Lock()
	g := codeGrant{challenge: q.Get("code_challenge"), nonce: q.Get("nonce"), redirect: q.Get("redirect_uri"), account: account}
	if q.Get("max_age") != "" {
		g.authTime = time.Now()
	}
	p.codes[code] = g
	p.mu.Unlock()
	back, err := url.Parse(q.Get("redirect_uri"))
	if err != nil {
		http.Error(w, "bad redirect_uri", http.StatusBadRequest)
		return
	}
	bq := back.Query()
	bq.Set("code", code)
	bq.Set("state", q.Get("state"))
	back.RawQuery = bq.Encode()
	http.Redirect(w, r, back.String(), http.StatusFound)
}

func pickAccount(accounts []Account, sub string) (Account, bool) {
	for _, a := range accounts {
		if sub != "" && a.Sub == sub {
			return a, true
		}
	}
	return Account{}, false
}

type pickerEntry struct {
	Name, Username, Href string
}

var pickerPage = template.Must(template.New("picker").Parse(`<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chọn tài khoản thử</title>
<style>body{font:16px system-ui,sans-serif;max-width:420px;margin:48px auto;padding:0 16px}a{display:block;padding:12px 16px;margin:8px 0;border:1px solid #ccc;border-radius:8px;color:inherit;text-decoration:none}small{color:#666}</style>
</head><body><h1>Chọn tài khoản thử</h1><p><small>IdP giả của môi trường E2E local, không phải trang đăng nhập thật.</small></p>
{{range .}}<a href="{{.Href}}">Đăng nhập là {{.Name}} <small>@{{.Username}}</small></a>
{{end}}</body></html>`))

// renderPicker lists accounts as links that repeat the authorization
// request with the chosen account.
func renderPicker(w http.ResponseWriter, q url.Values, accounts []Account) {
	entries := make([]pickerEntry, 0, len(accounts))
	for _, a := range accounts {
		pq := url.Values{}
		for k, v := range q {
			pq[k] = v
		}
		pq.Set("account", a.Sub)
		entries = append(entries, pickerEntry{Name: a.Name, Username: a.PreferredUsername, Href: "/authorize?" + pq.Encode()})
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = pickerPage.Execute(w, entries)
}

func tokenError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"error": code})
}

func (p *Provider) token(w http.ResponseWriter, r *http.Request) {
	id, secret, ok := r.BasicAuth()
	if !ok || id != p.ClientID || secret != p.ClientSecret {
		tokenError(w, http.StatusUnauthorized, "invalid_client")
		return
	}
	if err := r.ParseForm(); err != nil {
		tokenError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	switch r.PostForm.Get("grant_type") {
	case "authorization_code":
		p.codeGrant(w, r)
	case "refresh_token":
		p.refreshGrant(w, r)
	default:
		tokenError(w, http.StatusBadRequest, "unsupported_grant_type")
	}
}

func (p *Provider) codeGrant(w http.ResponseWriter, r *http.Request) {
	code := r.PostForm.Get("code")
	p.mu.Lock()
	g, ok := p.codes[code]
	delete(p.codes, code)
	account, override := p.account, p.nonceOverride
	if p.accounts != nil {
		account = g.account
	}
	p.mu.Unlock()
	sum := sha256.Sum256([]byte(r.PostForm.Get("code_verifier")))
	if !ok || base64.RawURLEncoding.EncodeToString(sum[:]) != g.challenge || r.PostForm.Get("redirect_uri") != g.redirect {
		tokenError(w, http.StatusBadRequest, "invalid_grant")
		return
	}
	nonce := g.nonce
	if override != nil {
		nonce = *override
	}
	p.issueTokens(w, account, nonce, false, g.authTime)
}

func (p *Provider) refreshGrant(w http.ResponseWriter, r *http.Request) {
	p.mu.Lock()
	p.refreshCalls++
	mode, delay, account := p.refreshMode, p.refreshDelay, p.account
	gate, arrive := p.refreshGate, p.refreshArrive
	p.mu.Unlock()
	if gate != nil {
		arrive <- struct{}{}
		<-gate
	}
	time.Sleep(delay)
	switch mode {
	case RefreshServerError:
		tokenError(w, http.StatusInternalServerError, "server_error")
		return
	case RefreshInvalidGrant:
		tokenError(w, http.StatusBadRequest, "invalid_grant")
		return
	case RefreshInvalidClient:
		tokenError(w, http.StatusUnauthorized, "invalid_client")
		return
	case RefreshOK, RefreshBadIDToken:
	}
	rt := r.PostForm.Get("refresh_token")
	p.mu.Lock()
	valid := p.refreshTokens[rt]
	// Single use: a replayed token fails (the real IdP also ends the grant).
	p.refreshTokens[rt] = false
	if bound, ok := p.tokenAccount[rt]; ok && p.accounts != nil {
		account = bound
	}
	p.mu.Unlock()
	if !valid {
		tokenError(w, http.StatusBadRequest, "invalid_grant")
		return
	}
	p.issueTokens(w, account, "", mode == RefreshBadIDToken, time.Time{})
}

// issueTokens answers a successful grant with a new refresh token; with
// foreignKey the ID token is signed by a key outside the JWKS. A non-zero
// authTime becomes the auth_time claim.
func (p *Provider) issueTokens(w http.ResponseWriter, a Account, nonce string, foreignKey bool, authTime time.Time) {
	rt, at := "rt-"+randomString(), "at-"+randomString()
	p.mu.Lock()
	p.refreshTokens[rt] = true
	p.tokenAccount[rt] = a
	p.accessTokens[at] = a
	p.mu.Unlock()
	now := time.Now()
	claims := map[string]any{
		"iss": p.Issuer(), "aud": p.ClientID, "sub": a.Sub, "sid": a.SID,
		"iat": now.Unix(), "exp": now.Add(time.Hour).Unix(),
		"preferred_username": a.PreferredUsername,
	}
	if nonce != "" {
		claims["nonce"] = nonce
	}
	if !authTime.IsZero() {
		claims["auth_time"] = authTime.Unix()
	}
	key := p.key
	if foreignKey {
		other, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			tokenError(w, http.StatusInternalServerError, "server_error")
			return
		}
		key = other
	}
	idToken, err := p.sign(key, claims, "JWT")
	if err != nil {
		tokenError(w, http.StatusInternalServerError, "server_error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"access_token": at, "token_type": "Bearer", "expires_in": 900,
		"refresh_token": rt, "id_token": idToken, "scope": "openid profile email",
	})
}

func (p *Provider) revoke(w http.ResponseWriter, r *http.Request) {
	id, secret, ok := r.BasicAuth()
	if !ok || id != p.ClientID || secret != p.ClientSecret {
		tokenError(w, http.StatusUnauthorized, "invalid_client")
		return
	}
	if err := r.ParseForm(); err != nil {
		tokenError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	p.mu.Lock()
	p.revoked = append(p.revoked, r.PostForm.Get("token"))
	p.mu.Unlock()
	w.WriteHeader(http.StatusOK)
}

// userinfo answers for the account the bearer access token was issued to;
// without a known token it answers for the current account.
func (p *Provider) userinfo(w http.ResponseWriter, r *http.Request) {
	token, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	p.mu.Lock()
	a, ok := p.accessTokens[token]
	if !ok {
		a = p.account
	}
	mode := p.userInfoMode
	p.mu.Unlock()
	sub := a.Sub
	switch mode {
	case UserInfoServerError:
		tokenError(w, http.StatusInternalServerError, "server_error")
		return
	case UserInfoOtherSubject:
		sub = "other-" + a.Sub
	case UserInfoOK:
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"sub": sub, "preferred_username": a.PreferredUsername, "name": a.Name,
		"email": a.Email, "email_verified": a.EmailVerified,
	})
}

// Sign returns a compact ES256 JWS of claims with the given typ header
// (omitted when empty), signed by the provider's JWKS key.
func (p *Provider) Sign(claims map[string]any, typ string) (string, error) {
	return p.sign(p.key, claims, typ)
}

func (p *Provider) sign(key *ecdsa.PrivateKey, claims map[string]any, typ string) (string, error) {
	opts := (&jose.SignerOptions{}).WithHeader("kid", p.kid)
	if typ != "" {
		opts = opts.WithType(jose.ContentType(typ))
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.ES256, Key: key}, opts)
	if err != nil {
		return "", err
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	jws, err := signer.Sign(payload)
	if err != nil {
		return "", err
	}
	return jws.CompactSerialize()
}

// LogoutClaims returns valid back-channel logout token claims for sid (and
// the current account's sub); tests mutate them to build bad tokens.
func (p *Provider) LogoutClaims(sid string) map[string]any {
	p.mu.Lock()
	sub := p.account.Sub
	p.mu.Unlock()
	return map[string]any{
		"iss": p.Issuer(), "aud": p.ClientID, "sub": sub, "sid": sid,
		"iat": time.Now().Unix(), "exp": time.Now().Add(2 * time.Minute).Unix(),
		"jti":    fmt.Sprintf("jti-%s", randomString()),
		"events": map[string]any{"http://schemas.openid.net/event/backchannel-logout": map[string]any{}},
	}
}

// LogoutToken signs claims as a logout+jwt.
func (p *Provider) LogoutToken(t testing.TB, claims map[string]any) string {
	t.Helper()
	tok, err := p.Sign(claims, "logout+jwt")
	if err != nil {
		t.Fatal(err)
	}
	return tok
}
