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
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/go-jose/go-jose/v4"
	"golang.org/x/oauth2"
)

// Scopes requested by every chat client; no API scope, no offline_access.
var Scopes = []string{oidc.ScopeOpenID, "profile", "email"}

// MobileClientID is the native client registered at the IdP (auth-next
// chat-clients.ts). There is no desktop client: desktop runs the web app as
// a PWA and signs in with the web client.
const MobileClientID = "chat-mobile"

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
	// Reauth asks the IdP to authenticate the user again (prompt=login,
	// max_age=ReauthMaxAge), so the ID token's auth_time is recent; ADR 0006
	// sensitive actions check it.
	Reauth bool
}

// ReauthMaxAge is the max_age sent with a reauthentication request, in
// seconds; it matches the recent sign-in window of sensitive actions.
const ReauthMaxAge = 600

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
	switch {
	case r.Reauth:
		opts = append(opts, oauth2.SetAuthURLParam("prompt", "login"),
			oauth2.SetAuthURLParam("max_age", strconv.Itoa(ReauthMaxAge)))
	case r.Create:
		opts = append(opts, oauth2.SetAuthURLParam("prompt", "create"))
	}
	return st.oauth.AuthCodeURL(r.State, opts...), nil
}

// IDClaims are the claims the chat server uses: those of the ID token,
// completed from the userinfo endpoint (the IdP may leave the profile and
// email claims out of the ID token).
type IDClaims struct {
	Subject           string
	SessionID         string // sid
	Nonce             string
	PreferredUsername string
	Name              string
	Email             string
	EmailVerified     bool
	// EmailKnown reports that the IdP stated the email state: the ID token
	// carried the email claim, or userinfo answered. When false, Email and
	// EmailVerified say nothing and the stored email must be kept.
	EmailKnown bool
	// AuthTime is the ID token's auth_time (when the user last entered
	// credentials at the IdP); zero when the token has none.
	AuthTime time.Time
}

// rawIDClaims are the claims read from an ID token or a userinfo response.
type rawIDClaims struct {
	SID               string          `json:"sid"`
	PreferredUsername string          `json:"preferred_username"`
	Name              string          `json:"name"`
	Email             *string         `json:"email"`
	EmailVerified     json.RawMessage `json:"email_verified"`
	AuthTime          *float64        `json:"auth_time"`
}

// profile returns the profile and email claims; email is known when the
// email claim is present.
func (c rawIDClaims) profile(subject string) IDClaims {
	out := IDClaims{
		Subject: subject, SessionID: c.SID,
		PreferredUsername: c.PreferredUsername, Name: c.Name,
		EmailVerified: parseBool(c.EmailVerified), EmailKnown: c.Email != nil,
	}
	if c.Email != nil {
		out.Email = *c.Email
	}
	return out
}

// mergeUserInfo completes ID token claims with userinfo claims of the same
// subject: a userinfo value replaces the ID token's when it is not empty,
// and the userinfo answer always states the email (an absent email claim
// there means the account has none to share).
func mergeUserInfo(id, info IDClaims) IDClaims {
	if info.PreferredUsername != "" {
		id.PreferredUsername = info.PreferredUsername
	}
	if info.Name != "" {
		id.Name = info.Name
	}
	id.Email, id.EmailVerified, id.EmailKnown = info.Email, info.EmailVerified, true
	return id
}

// parseBool accepts a JSON boolean or the strings "true"/"false" some
// providers send; anything else, including an absent claim, is false.
func parseBool(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return false
	}
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
	// token, userinfo of another subject). IDToken and Claims are then empty,
	// while RefreshToken is valid and must still be stored: the IdP rotates it
	// on every refresh.
	ClaimsErr error
}

// Exchange redeems an authorization code with its PKCE verifier, verifies
// the returned ID token (iss, aud, ES256, exp) and completes its claims from
// userinfo. A userinfo answer for another subject fails the exchange
// (ErrInvalidToken); a userinfo outage does not: the ID token claims are
// used alone, with a warning. The caller checks the nonce.
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
	info, err := p.userInfo(ctx, st, tok)
	switch {
	case errors.Is(err, errUserInfoSubject):
		return Tokens{}, fmt.Errorf("%w: %w", ErrInvalidToken, err)
	case err == nil && info.Subject != claims.Subject:
		return Tokens{}, fmt.Errorf("%w: %w", ErrInvalidToken, errUserInfoSubject)
	case err != nil:
		p.cfg.Logger.Warn("IdP userinfo unavailable at sign-in; using the ID token claims alone", "err", err)
	default:
		claims = mergeUserInfo(claims, info)
	}
	return Tokens{AccessToken: tok.AccessToken, RefreshToken: tok.RefreshToken, IDToken: raw, Claims: claims}, nil
}

// errUserInfoSubject: the userinfo response has no subject or another
// subject than the ID token (OpenID Connect Core 1.0 §5.3.2).
var errUserInfoSubject = errors.New("auth: userinfo subject does not match the ID token")

// userInfo reads the claims of the userinfo endpoint with tok's access
// token. Its errors carry no token: go-oidc reports the HTTP status and the
// IdP's error body, or a decoding failure.
func (p *IdP) userInfo(ctx context.Context, st *idpState, tok *oauth2.Token) (IDClaims, error) {
	info, err := st.provider.UserInfo(p.clientContext(ctx), oauth2.StaticTokenSource(tok))
	if err != nil {
		return IDClaims{}, fmt.Errorf("auth: userinfo: %w", err)
	}
	if info.Subject == "" {
		return IDClaims{}, errUserInfoSubject
	}
	var c rawIDClaims
	if err := info.Claims(&c); err != nil {
		return IDClaims{}, fmt.Errorf("auth: userinfo claims: %w", err)
	}
	c.SID = ""
	return c.profile(info.Subject), nil
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
	claims := c.profile(idt.Subject)
	claims.Nonce = idt.Nonce
	if c.AuthTime != nil && *c.AuthTime > 0 {
		claims.AuthTime = numericDate(*c.AuthTime)
	}
	return claims, nil
}

// Refresh redeems a refresh token. ErrGrantEnded means the IdP answered
// invalid_grant and ErrRefreshRejected another client error (wrapped with
// the status and OAuth error code); any other error is transient. Once the
// token endpoint succeeded the error is nil: the returned RefreshToken is the
// rotated token (or the old one when the IdP did not rotate) and must be
// stored even when Tokens.ClaimsErr reports that the claims could not be
// verified. When the response carries an ID token it is verified and its
// claims are completed from userinfo, which must answer for the same
// subject; otherwise the claims are read from userinfo alone.
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
	raw, _ := tok.Extra("id_token").(string)
	var idClaims IDClaims
	if raw != "" {
		if idClaims, err = p.verifyIDToken(ctx, st, raw); err != nil {
			out.ClaimsErr = err
			return out, nil
		}
	}
	// A userinfo outage leaves the claims unknown rather than falling back to
	// an ID token without the email claim, which would clear a stored email.
	info, err := p.userInfo(ctx, st, tok)
	if err != nil {
		out.ClaimsErr = fmt.Errorf("after refresh: %w", err)
		return out, nil
	}
	if raw == "" {
		out.Claims = mergeUserInfo(IDClaims{Subject: info.Subject}, info)
		return out, nil
	}
	if info.Subject != idClaims.Subject {
		out.ClaimsErr = fmt.Errorf("%w: %w", ErrInvalidToken, errUserInfoSubject)
		return out, nil
	}
	out.IDToken, out.Claims = raw, mergeUserInfo(idClaims, info)
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
