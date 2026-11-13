package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/go-jose/go-jose/v4"
)

// securityEventType is the JWT typ of a Security Event Token (RFC 8417).
const securityEventType = "secevent+jwt"

// ErrNotSecurityEvent: the input is not a SET at all (not a single ES256
// JWS, or another typ). It wraps ErrInvalidToken; a SET that is well formed
// but fails verification returns ErrInvalidToken without it.
var ErrNotSecurityEvent = fmt.Errorf("%w: not a security event token", ErrInvalidToken)

// SecurityEvent is a verified SET the IdP pushed to the chat (auth-next
// ADR 0018).
type SecurityEvent struct {
	// Subject is the IdP account the event is about (acc_…).
	Subject string
	// JTI is the id of the delivery; the IdP reuses it when it retries.
	JTI string
}

type securityEventClaims struct {
	JTI    string                     `json:"jti"`
	Events map[string]json.RawMessage `json:"events"`
}

// VerifySecurityEvent checks a SET offline against the IdP's JWKS: ES256,
// typ secevent+jwt (so no ID, logout or access token passes), the issuer,
// audience in its aud, not expired, a subject and a jti, and event among its
// events. It returns ErrIdPUnavailable before discovery, an error wrapping
// ErrNotSecurityEvent for input that is not a SET, and an error wrapping
// ErrInvalidToken for a SET that fails.
func (p *IdP) VerifySecurityEvent(ctx context.Context, raw, audience, event string) (SecurityEvent, error) {
	st, err := p.ready()
	if err != nil {
		return SecurityEvent{}, err
	}
	jws, err := jose.ParseSigned(raw, []jose.SignatureAlgorithm{jose.ES256})
	if err != nil || len(jws.Signatures) != 1 {
		return SecurityEvent{}, fmt.Errorf("%w: not a single ES256 JWS", ErrNotSecurityEvent)
	}
	typ, _ := jws.Signatures[0].Protected.ExtraHeaders[jose.HeaderType].(string)
	if t := strings.ToLower(typ); t != securityEventType && t != "application/"+securityEventType {
		return SecurityEvent{}, fmt.Errorf("%w: typ %q", ErrNotSecurityEvent, typ)
	}
	verifier := st.provider.Verifier(&oidc.Config{ClientID: audience, SupportedSigningAlgs: signingAlgs})
	tok, err := verifier.Verify(p.clientContext(ctx), raw)
	if err != nil {
		return SecurityEvent{}, fmt.Errorf("%w: %w", ErrInvalidToken, err)
	}
	var c securityEventClaims
	if err := tok.Claims(&c); err != nil {
		return SecurityEvent{}, fmt.Errorf("%w: claims: %w", ErrInvalidToken, err)
	}
	switch {
	case tok.Subject == "" || len(tok.Subject) > maxClaimLength:
		return SecurityEvent{}, fmt.Errorf("%w: bad sub", ErrInvalidToken)
	case c.JTI == "" || len(c.JTI) > maxClaimLength:
		return SecurityEvent{}, fmt.Errorf("%w: bad jti", ErrInvalidToken)
	case c.Events[event] == nil:
		return SecurityEvent{}, fmt.Errorf("%w: no %s event", ErrInvalidToken, event)
	}
	return SecurityEvent{Subject: tok.Subject, JTI: c.JTI}, nil
}
