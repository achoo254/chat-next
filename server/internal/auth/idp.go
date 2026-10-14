// Package auth signs users in through the tenant's IdP (hoandat-auth) and
// runs chat sessions bound to the IdP grant (ADR 0006): the OIDC web client,
// the session manager with its hourly grant check, and the HTTP routes under
// /auth.
package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/go-jose/go-jose/v4"
	"golang.org/x/oauth2"
)

// Scopes requested by every chat client; no API scope, no offline_access.
var Scopes = []string{oidc.ScopeOpenID, "profile", "email"}

// Native client ids registered at the IdP (hoandat-auth chat-clients.ts).
const (
	MobileClientID  = "chat-mobile"
	DesktopClientID = "chat-desktop"
)

// Errors of IdP calls.
var (
	// ErrIdPUnavailable: discovery has not succeeded yet.
	ErrIdPUnavailable = errors.New("auth: IdP discovery not completed")
	// ErrGrantEnded: the token endpoint answered invalid_grant.
	ErrGrantEnded = errors.New("auth: IdP grant ended")
	// ErrRefreshRejected: the token endpoint refused a refresh with a client
	// error other than invalid_grant (invalid_client, unauthorized_client,
	// ...). The grant may be fine; the client registration or secret is not,
	// and retrying does not help until an operator fixes it.
	ErrRefreshRejected = errors.New("auth: IdP rejected the refresh request")
	// ErrInvalidToken: an ID or logout token failed verification.
	ErrInvalidToken = errors.New("auth: invalid token")
)

const (
	backchannelLogoutEvent = "http://schemas.openid.net/event/backchannel-logout"
	logoutTokenType        = "logout+jwt"
	logoutTokenMaxAge      = 2 * time.Minute
	clockSkew              = 30 * time.Second
	idpCallTimeout         = 15 * time.Second
)

// signingAlgs is the only accepted JWS algorithm for ID and logout tokens.
var signingAlgs = []string{oidc.ES256}

// IdPConfig configures the web client of one tenant.
type IdPConfig struct {
	Issuer       string
	ClientID     string
	ClientSecret string
	RedirectURL  string
	// HTTPClient is used for discovery, JWKS and token calls; nil uses a
	// client with a 15 s timeout.
	HTTPClient *http.Client
	Logger     *slog.Logger
}

// IdP is the OIDC client. Endpoints come only from discovery, which runs at
// start and is retried until it succeeds; until then sign-in and the grant
// check report ErrIdPUnavailable while existing sessions keep working.
type IdP struct {
	cfg   IdPConfig
	state atomic.Pointer[idpState]
}

type idpState struct {
	provider       *oidc.Provider
	oauth          oauth2.Config
	idVerifier     *oidc.IDTokenVerifier
	logoutVerifier *oidc.IDTokenVerifier
	authURL        string
	revocationURL  string
	endSessionURL  string
}

// NewIdP returns a client that is not ready until Discover succeeds.
func NewIdP(cfg IdPConfig) *IdP {
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = &http.Client{Timeout: idpCallTimeout}
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	return &IdP{cfg: cfg}
}

// ClientID is the web client id.
func (p *IdP) ClientID() string { return p.cfg.ClientID }

// Issuer is the configured issuer.
func (p *IdP) Issuer() string { return p.cfg.Issuer }

func (p *IdP) clientContext(ctx context.Context) context.Context {
	ctx = oidc.ClientContext(ctx, p.cfg.HTTPClient)
	return context.WithValue(ctx, oauth2.HTTPClient, p.cfg.HTTPClient)
}

// Discover fetches the discovery document once.
func (p *IdP) Discover(ctx context.Context) error {
	provider, err := oidc.NewProvider(p.clientContext(ctx), p.cfg.Issuer)
	if err != nil {
		return fmt.Errorf("auth: discovery: %w", err)
	}
	var extra struct {
		RevocationEndpoint string `json:"revocation_endpoint"`
		EndSessionEndpoint string `json:"end_session_endpoint"`
	}
	if err := provider.Claims(&extra); err != nil {
		return fmt.Errorf("auth: discovery claims: %w", err)
	}
	endpoint := provider.Endpoint()
	endpoint.AuthStyle = oauth2.AuthStyleInHeader // client_secret_basic
	p.state.Store(&idpState{
		provider: provider,
		oauth: oauth2.Config{
			ClientID:     p.cfg.ClientID,
			ClientSecret: p.cfg.ClientSecret,
			Endpoint:     endpoint,
			RedirectURL:  p.cfg.RedirectURL,
			Scopes:       Scopes,
		},
		idVerifier: provider.Verifier(&oidc.Config{ClientID: p.cfg.ClientID, SupportedSigningAlgs: signingAlgs}),
		// Logout tokens need not carry exp; their age is checked from iat.
		logoutVerifier: provider.Verifier(&oidc.Config{ClientID: p.cfg.ClientID, SupportedSigningAlgs: signingAlgs, SkipExpiryCheck: true}),
		authURL:        endpoint.AuthURL,
		revocationURL:  extra.RevocationEndpoint,
		endSessionURL:  extra.EndSessionEndpoint,
	})
	return nil
}

// RunDiscovery retries Discover with exponential backoff (1 s to 1 min)
// until it succeeds or ctx ends.
func (p *IdP) RunDiscovery(ctx context.Context) {
	delay := time.Second
	for {
		err := p.Discover(ctx)
		if err == nil {
			p.cfg.Logger.Info("IdP discovery completed", "issuer", p.cfg.Issuer)
			return
		}
		p.cfg.Logger.Warn("IdP discovery failed; retrying", "issuer", p.cfg.Issuer, "retry_in", delay, "err", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
		delay = min(delay*2, time.Minute)
	}
}

// Ready reports whether discovery has completed.
func (p *IdP) Ready() bool {
	return p.state.Load() != nil
}

func (p *IdP) ready() (*idpState, error) {
	st := p.state.Load()
	if st == nil {
		return nil, ErrIdPUnavailable
	}
	return st, nil
}

// AuthorizationEndpoint is the discovered authorization endpoint.
func (p *IdP) AuthorizationEndpoint() (string, error) {
	st, err := p.ready()
	if err != nil {
		return "", err
	}
	return st.authURL, nil
}

// AuthRequest holds the per-attempt secrets of an authorization request.
type AuthRequest struct {
	State    string
	Nonce    string
	Verifier string
	Locale   string // ui_locales; empty to omit
	Create   bool   // prompt=create opens the IdP sign-up page
}

// AuthCodeURL builds the authorization URL (Code + PKCE S256).
func (p *IdP) AuthCodeURL(r AuthRequest) (string, error) {
	st, err := p.ready()
	if err != nil {
		return "", err
	}
	opts := []oauth2.AuthCodeOption{oauth2.S256ChallengeOption(r.Verifier), oidc.Nonce(r.Nonce)}
	if r.Locale != "" {
		opts = append(opts, oauth2.SetAuthURLParam("ui_locales", r.Locale))
	}
	if r.Create {
		opts = append(opts, oauth2.SetAuthURLParam("prompt", "create"))
	}
	return st.oauth.AuthCodeURL(r.State, opts...), nil
}

// IDClaims are the ID token claims the chat server uses.
type IDClaims struct {
	Subject           string
	SessionID         string // sid
	Nonce             string
	PreferredUsername string
	Name              string
	Email             string
	EmailVerified     bool
}

type rawIDClaims struct {
	SID               string          `json:"sid"`
	PreferredUsername string          `json:"preferred_username"`
	Name              string          `json:"name"`
	Email             string          `json:"email"`
	EmailVerified     json.RawMessage `json:"email_verified"`
}

// parseBool accepts a JSON boolean or the strings "true"/"false" some
// providers send.
func parseBool(raw json.RawMessage) bool {
	var b bool
	if json.Unmarshal(raw, &b) == nil {
		return b
	}
	var s string
	return json.Unmarshal(raw, &s) == nil && s == "true"
}

// Tokens is the result of a code exchange or refresh. IDToken is empty when
// a refresh response carries none.
type Tokens struct {
	AccessToken  string
	RefreshToken string
	IDToken      string
	Claims       IDClaims
	// ClaimsErr is set by Refresh when the token endpoint succeeded but the
	// ID token or userinfo could not be verified (JWKS or userinfo outage, bad
	// token). IDToken and Claims are then empty, while RefreshToken is valid
	// and must still be stored: the IdP rotates it on every refresh.
	ClaimsErr error
}

// Exchange redeems an authorization code with its PKCE verifier and verifies
// the returned ID token (iss, aud, ES256, exp). The caller checks the nonce.
func (p *IdP) Exchange(ctx context.Context, code, verifier string) (Tokens, error) {
	st, err := p.ready()
	if err != nil {
		return Tokens{}, err
	}
	tok, err := st.oauth.Exchange(p.clientContext(ctx), code, oauth2.VerifierOption(verifier))
	if err != nil {
		return Tokens{}, fmt.Errorf("auth: code exchange: %w", describeTokenError(err))
	}
	raw, _ := tok.Extra("id_token").(string)
	if raw == "" {
		return Tokens{}, fmt.Errorf("%w: token response has no id_token", ErrInvalidToken)
	}
	claims, err := p.verifyIDToken(ctx, st, raw)
	if err != nil {
		return Tokens{}, err
	}
	return Tokens{AccessToken: tok.AccessToken, RefreshToken: tok.RefreshToken, IDToken: raw, Claims: claims}, nil
}

func (p *IdP) verifyIDToken(ctx context.Context, st *idpState, raw string) (IDClaims, error) {
	idt, err := st.idVerifier.Verify(p.clientContext(ctx), raw)
	if err != nil {
		return IDClaims{}, fmt.Errorf("%w: %w", ErrInvalidToken, err)
	}
	var c rawIDClaims
	if err := idt.Claims(&c); err != nil {
		return IDClaims{}, fmt.Errorf("%w: claims: %w", ErrInvalidToken, err)
	}
	if idt.Subject == "" {
		return IDClaims{}, fmt.Errorf("%w: no sub", ErrInvalidToken)
	}
	return IDClaims{
		Subject:           idt.Subject,
		SessionID:         c.SID,
		Nonce:             idt.Nonce,
		PreferredUsername: c.PreferredUsername,
		Name:              c.Name,
		Email:             c.Email,
		EmailVerified:     parseBool(c.EmailVerified),
	}, nil
}

// Refresh redeems a refresh token. ErrGrantEnded means the IdP answered
// invalid_grant and ErrRefreshRejected another client error (wrapped with
// the status and OAuth error code); any other error is transient. Once the
// token endpoint succeeded the error is nil: the returned RefreshToken is the
// rotated token (or the old one when the IdP did not rotate) and must be
// stored even when Tokens.ClaimsErr reports that the claims could not be
// verified. When the response carries an ID token it is verified; otherwise
// the claims are read from userinfo.
func (p *IdP) Refresh(ctx context.Context, refreshToken string) (Tokens, error) {
	st, err := p.ready()
	if err != nil {
		return Tokens{}, err
	}
	cctx := p.clientContext(ctx)
	tok, err := st.oauth.TokenSource(cctx, &oauth2.Token{RefreshToken: refreshToken}).Token()
	if err != nil {
		var re *oauth2.RetrieveError
		if errors.As(err, &re) {
			if re.ErrorCode == "invalid_grant" {
				return Tokens{}, ErrGrantEnded
			}
			if isPermanentClientError(tokenErrorStatus(re)) {
				return Tokens{}, fmt.Errorf("%w: %w", ErrRefreshRejected, describeTokenError(err))
			}
		}
		return Tokens{}, fmt.Errorf("auth: refresh: %w", describeTokenError(err))
	}
	out := Tokens{AccessToken: tok.AccessToken, RefreshToken: tok.RefreshToken}
	if raw, _ := tok.Extra("id_token").(string); raw != "" {
		claims, err := p.verifyIDToken(ctx, st, raw)
		if err != nil {
			out.ClaimsErr = err
			return out, nil
		}
		out.IDToken, out.Claims = raw, claims
		return out, nil
	}
	info, err := st.provider.UserInfo(cctx, oauth2.StaticTokenSource(tok))
	if err != nil {
		out.ClaimsErr = fmt.Errorf("auth: userinfo after refresh: %w", err)
		return out, nil
	}
	out.Claims = IDClaims{Subject: info.Subject, Email: info.Email, EmailVerified: info.EmailVerified}
	return out, nil
}

// isPermanentClientError reports a 4xx status that retrying will not fix;
// 408 and 429 are transient.
func isPermanentClientError(status int) bool {
	return status >= 400 && status < 500 &&
		status != http.StatusRequestTimeout && status != http.StatusTooManyRequests
}

func tokenErrorStatus(re *oauth2.RetrieveError) int {
	if re.Response == nil {
		return 0
	}
	return re.Response.StatusCode
}

// describeTokenError drops the response body of token endpoint errors, which
// is not ours to log, and keeps the status and OAuth error code.
func describeTokenError(err error) error {
	var re *oauth2.RetrieveError
	if errors.As(err, &re) {
		return fmt.Errorf("token endpoint status %d error %q", tokenErrorStatus(re), re.ErrorCode)
	}
	return err
}

// Revoke revokes a refresh token (and with it the grant) at the revocation
// endpoint. Callers treat it as best effort.
func (p *IdP) Revoke(ctx context.Context, refreshToken string) error {
	st, err := p.ready()
	if err != nil {
		return err
	}
	if st.revocationURL == "" {
		return errors.New("auth: IdP has no revocation_endpoint")
	}
	form := url.Values{"token": {refreshToken}, "token_type_hint": {"refresh_token"}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, st.revocationURL, strings.NewReader(form.Encode()))
	if err != nil {
		return fmt.Errorf("auth: revoke: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.SetBasicAuth(url.QueryEscape(p.cfg.ClientID), url.QueryEscape(p.cfg.ClientSecret))
	resp, err := p.cfg.HTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("auth: revoke: %w", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("auth: revoke: status %d", resp.StatusCode)
	}
	return nil
}

// EndSessionURL builds the RP-initiated logout URL; ok is false when the IdP
// has no end_session_endpoint or is not discovered yet.
func (p *IdP) EndSessionURL(idTokenHint, postLogoutRedirect string) (string, bool) {
	st := p.state.Load()
	if st == nil || st.endSessionURL == "" {
		return "", false
	}
	u, err := url.Parse(st.endSessionURL)
	if err != nil {
		return "", false
	}
	q := u.Query()
	q.Set("client_id", p.cfg.ClientID)
	q.Set("post_logout_redirect_uri", postLogoutRedirect)
	if idTokenHint != "" {
		q.Set("id_token_hint", idTokenHint)
	}
	u.RawQuery = q.Encode()
	return u.String(), true
}

// LogoutClaims are the verified claims of a back-channel logout token.
type LogoutClaims struct {
	Subject   string
	SessionID string
	JTI       string
}

type rawLogoutClaims struct {
	IssuedAt *float64                   `json:"iat"`
	Expiry   *float64                   `json:"exp"`
	JTI      string                     `json:"jti"`
	SID      string                     `json:"sid"`
	Events   map[string]json.RawMessage `json:"events"`
	Nonce    *json.RawMessage           `json:"nonce"`
}

// VerifyLogoutToken validates a back-channel logout token (OpenID Connect
// Back-Channel Logout 1.0 §2.6): ES256 signature from the IdP JWKS, header
// typ logout+jwt, iss, aud containing the client id, iat at most two minutes
// old, the back-channel logout event, no nonce, a jti, and sub or sid.
func (p *IdP) VerifyLogoutToken(ctx context.Context, raw string, now time.Time) (LogoutClaims, error) {
	st, err := p.ready()
	if err != nil {
		return LogoutClaims{}, err
	}
	jws, err := jose.ParseSigned(raw, []jose.SignatureAlgorithm{jose.ES256})
	if err != nil || len(jws.Signatures) != 1 {
		return LogoutClaims{}, fmt.Errorf("%w: not a single ES256 JWS", ErrInvalidToken)
	}
	typ, _ := jws.Signatures[0].Protected.ExtraHeaders[jose.HeaderType].(string)
	if t := strings.ToLower(typ); t != logoutTokenType && t != "application/"+logoutTokenType {
		return LogoutClaims{}, fmt.Errorf("%w: typ %q", ErrInvalidToken, typ)
	}
	idt, err := st.logoutVerifier.Verify(p.clientContext(ctx), raw)
	if err != nil {
		return LogoutClaims{}, fmt.Errorf("%w: %w", ErrInvalidToken, err)
	}
	var c rawLogoutClaims
	if err := idt.Claims(&c); err != nil {
		return LogoutClaims{}, fmt.Errorf("%w: claims: %w", ErrInvalidToken, err)
	}
	if c.IssuedAt == nil {
		return LogoutClaims{}, fmt.Errorf("%w: no iat", ErrInvalidToken)
	}
	issuedAt := numericDate(*c.IssuedAt)
	switch {
	case now.Sub(issuedAt) > logoutTokenMaxAge:
		return LogoutClaims{}, fmt.Errorf("%w: issued more than %s ago", ErrInvalidToken, logoutTokenMaxAge)
	case issuedAt.After(now.Add(clockSkew)):
		return LogoutClaims{}, fmt.Errorf("%w: issued in the future", ErrInvalidToken)
	case c.Expiry != nil && !numericDate(*c.Expiry).Add(clockSkew).After(now):
		return LogoutClaims{}, fmt.Errorf("%w: expired", ErrInvalidToken)
	case c.Events == nil || c.Events[backchannelLogoutEvent] == nil:
		return LogoutClaims{}, fmt.Errorf("%w: no back-channel logout event", ErrInvalidToken)
	case c.Nonce != nil:
		return LogoutClaims{}, fmt.Errorf("%w: has a nonce", ErrInvalidToken)
	case c.JTI == "":
		return LogoutClaims{}, fmt.Errorf("%w: no jti", ErrInvalidToken)
	case idt.Subject == "" && c.SID == "":
		return LogoutClaims{}, fmt.Errorf("%w: neither sub nor sid", ErrInvalidToken)
	}
	return LogoutClaims{Subject: idt.Subject, SessionID: c.SID, JTI: c.JTI}, nil
}

// numericDate converts a JWT NumericDate (seconds, possibly fractional).
func numericDate(seconds float64) time.Time {
	return time.UnixMilli(int64(seconds * 1000))
}
