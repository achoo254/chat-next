package webpush

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

// VAPID token lifetimes (RFC 8292 section 2: at most 24 hours).
const (
	tokenTTL = 12 * time.Hour
	// tokenRenew: a cached token is replaced when less than this is left.
	tokenRenew = time.Hour
)

// VAPID signs the Authorization header of push requests (RFC 8292) with
// the server's P-256 key. Tokens are cached per push service origin.
type VAPID struct {
	key       *ecdsa.PrivateKey
	publicKey []byte
	subject   string

	mu     sync.Mutex
	tokens map[string]vapidToken
}

type vapidToken struct {
	jwt     string
	expires time.Time
}

// ParseVAPIDKey reads a VAPID private key: the 32-byte P-256 scalar in
// base64url (the "d" of its JWK), padded or not. Errors never contain the
// key.
func ParseVAPIDKey(encoded string) (*ecdsa.PrivateKey, error) {
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(strings.TrimSpace(encoded), "="))
	if err != nil {
		return nil, errors.New("webpush: VAPID private key must be base64url")
	}
	key, err := ecdsa.ParseRawPrivateKey(elliptic.P256(), raw)
	if err != nil {
		return nil, errors.New("webpush: VAPID private key must be a 32-byte P-256 scalar")
	}
	return key, nil
}

// NewVAPID returns the signer of key. subject is the contact of the
// operator that push services may use (a mailto: or https: URI).
func NewVAPID(key *ecdsa.PrivateKey, subject string) (*VAPID, error) {
	if key == nil || key.Curve != elliptic.P256() {
		return nil, errors.New("webpush: VAPID key must be P-256")
	}
	if !strings.HasPrefix(subject, "mailto:") && !strings.HasPrefix(subject, "https://") {
		return nil, errors.New("webpush: VAPID subject must be a mailto: or https: URI")
	}
	pub, err := key.PublicKey.Bytes()
	if err != nil {
		return nil, fmt.Errorf("webpush: VAPID public key: %w", err)
	}
	return &VAPID{key: key, publicKey: pub, subject: subject, tokens: map[string]vapidToken{}}, nil
}

// PublicKey is the uncompressed public key: the applicationServerKey
// browsers subscribe with.
func (v *VAPID) PublicKey() []byte {
	return v.publicKey
}

// Authorization returns the value of the Authorization header for a push
// service origin (scheme://host of the endpoint).
func (v *VAPID) Authorization(audience string, now time.Time) (string, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	t, ok := v.tokens[audience]
	if !ok || t.expires.Sub(now) < tokenRenew {
		jwt, err := v.sign(audience, now.Add(tokenTTL))
		if err != nil {
			return "", err
		}
		t = vapidToken{jwt: jwt, expires: now.Add(tokenTTL)}
		if len(v.tokens) > 64 {
			// Only a handful of push services exist; never grow unbounded.
			clear(v.tokens)
		}
		v.tokens[audience] = t
	}
	return "vapid t=" + t.jwt + ", k=" + base64.RawURLEncoding.EncodeToString(v.publicKey), nil
}

// sign makes an ES256 JWT {aud, exp, sub}.
func (v *VAPID) sign(audience string, expires time.Time) (string, error) {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"typ":"JWT","alg":"ES256"}`))
	claims, err := json.Marshal(struct {
		Aud string `json:"aud"`
		Exp int64  `json:"exp"`
		Sub string `json:"sub"`
	}{audience, expires.Unix(), v.subject})
	if err != nil {
		return "", err
	}
	signing := header + "." + base64.RawURLEncoding.EncodeToString(claims)
	digest := sha256.Sum256([]byte(signing))
	r, s, err := ecdsa.Sign(rand.Reader, v.key, digest[:])
	if err != nil {
		return "", fmt.Errorf("webpush: sign VAPID token: %w", err)
	}
	// JWS ES256: R and S as 32-byte big-endian integers (RFC 7518 3.4).
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return signing + "." + base64.RawURLEncoding.EncodeToString(sig), nil
}
