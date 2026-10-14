// Package idptest is a fake OpenID Connect provider for tests, shaped like
// hoandat-auth for the chat-web client: discovery, an ES256 JWKS, an
// authorize endpoint that immediately redirects back with a code, a token
// endpoint (authorization_code with PKCE S256 and client_secret_basic, and
// rotating single-use refresh tokens), revocation, end_session and userinfo.
// It also signs back-channel logout tokens.
package idptest

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
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
	refreshTokens map[string]bool // issued token -> still valid
	codes         map[string]codeGrant
	authorizes    []Authorize
	revoked       []string
}

// New starts a provider for the given client; it stops with the test.
func New(t testing.TB, clientID, clientSecret string) *Provider {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	p := &Provider{
		ClientID: clientID, ClientSecret: clientSecret,
		key: key, kid: "test-key-1",
		account: Account{
			Sub: "acc_test", SID: "sid-1", PreferredUsername: "tester", Name: "Người Thử",
			Email: "tester@example.com", EmailVerified: true,
		},
		refreshTokens: map[string]bool{},
		codes:         map[string]codeGrant{},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /.well-known/openid-configuration", p.discovery)
	mux.HandleFunc("GET /jwks", p.jwks)
	mux.HandleFunc("GET /authorize", p.authorize)
	mux.HandleFunc("POST /token", p.token)
	mux.HandleFunc("POST /revoke", p.revoke)
	mux.HandleFunc("GET /session/end", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("GET /me", p.userinfo)
	p.Server = httptest.NewServer(mux)
	t.Cleanup(p.Server.Close)
	return p
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
	code := randomString()
	p.mu.Lock()
	p.codes[code] = codeGrant{challenge: q.Get("code_challenge"), nonce: q.Get("nonce"), redirect: q.Get("redirect_uri")}
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
	p.issueTokens(w, account, nonce)
}

func (p *Provider) refreshGrant(w http.ResponseWriter, r *http.Request) {
	p.mu.Lock()
	p.refreshCalls++
	mode, delay, account := p.refreshMode, p.refreshDelay, p.account
	p.mu.Unlock()
	time.Sleep(delay)
	switch mode {
	case RefreshServerError:
		tokenError(w, http.StatusInternalServerError, "server_error")
		return
	case RefreshInvalidGrant:
		tokenError(w, http.StatusBadRequest, "invalid_grant")
		return
	case RefreshOK:
	}
	rt := r.PostForm.Get("refresh_token")
	p.mu.Lock()
	valid := p.refreshTokens[rt]
	// Single use: a replayed token fails (the real IdP also ends the grant).
	p.refreshTokens[rt] = false
	p.mu.Unlock()
	if !valid {
		tokenError(w, http.StatusBadRequest, "invalid_grant")
		return
	}
	p.issueTokens(w, account, "")
}

func (p *Provider) issueTokens(w http.ResponseWriter, a Account, nonce string) {
	rt := "rt-" + randomString()
	p.mu.Lock()
	p.refreshTokens[rt] = true
	p.mu.Unlock()
	now := time.Now()
	claims := map[string]any{
		"iss": p.Issuer(), "aud": p.ClientID, "sub": a.Sub, "sid": a.SID,
		"iat": now.Unix(), "exp": now.Add(time.Hour).Unix(),
		"preferred_username": a.PreferredUsername, "name": a.Name,
		"email": a.Email, "email_verified": a.EmailVerified,
	}
	if nonce != "" {
		claims["nonce"] = nonce
	}
	idToken, err := p.Sign(claims, "JWT")
	if err != nil {
		tokenError(w, http.StatusInternalServerError, "server_error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"access_token": "at-" + randomString(), "token_type": "Bearer", "expires_in": 900,
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

func (p *Provider) userinfo(w http.ResponseWriter, _ *http.Request) {
	p.mu.Lock()
	a := p.account
	p.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"sub": a.Sub, "email": a.Email, "email_verified": a.EmailVerified})
}

// Sign returns a compact ES256 JWS of claims with the given typ header
// (omitted when empty), signed by the provider's JWKS key.
func (p *Provider) Sign(claims map[string]any, typ string) (string, error) {
	opts := (&jose.SignerOptions{}).WithHeader("kid", p.kid)
	if typ != "" {
		opts = opts.WithType(jose.ContentType(typ))
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.ES256, Key: p.key}, opts)
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
