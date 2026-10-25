package auth

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/go-jose/go-jose/v4"
)

// accessTokenType is the JWT typ of IdP access tokens (RFC 9068).
const accessTokenType = "at+jwt"

// maxClaimLength bounds sub and client_id, which end up in logs and limits.
const maxClaimLength = 255

// AccessToken is a verified access token that the IdP issued for one of its
// resources (an ES256 JWT whose aud is the resource, e.g. the chat's /mcp).
type AccessToken struct {
	// Subject is the IdP account id (acc_…), the idp_sub of a chat user.
	Subject string
	// ClientID is the OAuth client holding the token (for MCP, a
	// dynamically registered client).
	ClientID string
	Scopes   []string
	Expiry   time.Time
}

// HasScope reports whether the token carries scope.
func (t AccessToken) HasScope(scope string) bool {
	return slices.Contains(t.Scopes, scope)
}

type accessTokenClaims struct {
	ClientID string `json:"client_id"`
	Scope    string `json:"scope"`
}

// VerifyAccessToken checks an access token offline against the IdP's JWKS:
// ES256, typ at+jwt (so an ID or logout token never passes), the issuer,
// audience in its aud, not expired, and a subject and client_id. It returns
// ErrIdPUnavailable before discovery and an error wrapping ErrInvalidToken
// for any token that fails.
func (p *IdP) VerifyAccessToken(ctx context.Context, raw, audience string) (AccessToken, error) {
	st, err := p.ready()
	if err != nil {
		return AccessToken{}, err
	}
	jws, err := jose.ParseSigned(raw, []jose.SignatureAlgorithm{jose.ES256})
	if err != nil || len(jws.Signatures) != 1 {
		return AccessToken{}, fmt.Errorf("%w: not a single ES256 JWS", ErrInvalidToken)
	}
	typ, _ := jws.Signatures[0].Protected.ExtraHeaders[jose.HeaderType].(string)
	if t := strings.ToLower(typ); t != accessTokenType && t != "application/"+accessTokenType {
		return AccessToken{}, fmt.Errorf("%w: typ %q", ErrInvalidToken, typ)
	}
	verifier := st.provider.Verifier(&oidc.Config{ClientID: audience, SupportedSigningAlgs: signingAlgs})
	tok, err := verifier.Verify(p.clientContext(ctx), raw)
	if err != nil {
		return AccessToken{}, fmt.Errorf("%w: %w", ErrInvalidToken, err)
	}
	var c accessTokenClaims
	if err := tok.Claims(&c); err != nil {
		return AccessToken{}, fmt.Errorf("%w: claims: %w", ErrInvalidToken, err)
	}
	switch {
	case tok.Subject == "" || len(tok.Subject) > maxClaimLength:
		return AccessToken{}, fmt.Errorf("%w: bad sub", ErrInvalidToken)
	case c.ClientID == "" || len(c.ClientID) > maxClaimLength:
		return AccessToken{}, fmt.Errorf("%w: bad client_id", ErrInvalidToken)
	}
	return AccessToken{Subject: tok.Subject, ClientID: c.ClientID, Scopes: strings.Fields(c.Scope), Expiry: tok.Expiry}, nil
}
