// Package keyproof checks that a caller holds the X25519 private key of a
// public key it registers (app.v1.KeyChallenge): account devices
// (MachinesService.RegisterDevice) and machines
// (MachineAgentService.RegisterMachine).
//
// A challenge is a throwaway X25519 key pair of the server and a nonce. The
// caller answers mac = HMAC-SHA256(X25519(its private key, server_key),
// nonce): only the holder of the private key, or the server, can compute
// that shared secret. The server keeps no state: the throwaway private key
// is HMAC-SHA256(secret, label ‖ purpose ‖ nonce ‖ expires_at), so it is
// derived again at verification and a challenge of one purpose never checks
// for another. A proof can be replayed until its challenge expires, by
// someone who saw it, for the same public key only: it grants nothing that
// key's holder did not ask for.
package keyproof

import (
	"crypto/ecdh"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"errors"
	"fmt"
	"time"

	appv1 "app.local/server/gen/app/v1"
)

// Purpose names what a challenge is for.
type Purpose string

// The purposes of challenges.
const (
	AccountDevice Purpose = "account-device"
	Machine       Purpose = "machine"
)

const (
	// TTL is how long a challenge can be answered.
	TTL = 2 * time.Minute
	// KeyLen is the length of X25519 keys, nonces and MACs.
	KeyLen    = 32
	label     = "chat-key-challenge-v1"
	minSecret = 32
)

// ErrBadProof: the proof is missing, malformed, expired, of another purpose
// or does not check.
var ErrBadProof = errors.New("keyproof: bad proof")

// Issuer makes and checks challenges.
type Issuer struct {
	secret []byte
	now    func() time.Time
}

// New returns an Issuer keyed by secret (at least 32 bytes, kept by the
// server: every instance with the same secret checks the others'
// challenges).
func New(secret []byte) (*Issuer, error) {
	if len(secret) < minSecret {
		return nil, fmt.Errorf("keyproof: secret shorter than %d bytes", minSecret)
	}
	return &Issuer{secret: append([]byte(nil), secret...), now: time.Now}, nil
}

// SetClock replaces the clock (tests).
func (i *Issuer) SetClock(now func() time.Time) { i.now = now }

// Challenge returns a new challenge for purpose.
func (i *Issuer) Challenge(purpose Purpose) (*appv1.KeyChallenge, error) {
	nonce := make([]byte, KeyLen)
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("keyproof: random nonce: %w", err)
	}
	expires := i.now().Add(TTL).Unix()
	priv, err := i.serverKey(purpose, nonce, expires)
	if err != nil {
		return nil, err
	}
	return &appv1.KeyChallenge{ServerKey: priv.PublicKey().Bytes(), Nonce: nonce, ExpiresAt: expires}, nil
}

// Verify checks proof for publicKey (the caller's X25519 public key) and
// purpose; any failure is ErrBadProof.
func (i *Issuer) Verify(purpose Purpose, publicKey []byte, proof *appv1.KeyProof) error {
	c := proof.GetChallenge()
	if c == nil || len(c.GetNonce()) != KeyLen || len(c.GetServerKey()) != KeyLen || len(proof.GetMac()) != KeyLen ||
		len(publicKey) != KeyLen {
		return ErrBadProof
	}
	now := i.now().Unix()
	// A challenge expiring later than one made now could not come from
	// Challenge: refuse it without deriving anything.
	if c.GetExpiresAt() <= now || c.GetExpiresAt() > now+int64(TTL/time.Second) {
		return ErrBadProof
	}
	priv, err := i.serverKey(purpose, c.GetNonce(), c.GetExpiresAt())
	if err != nil {
		return ErrBadProof
	}
	if subtle.ConstantTimeCompare(priv.PublicKey().Bytes(), c.GetServerKey()) != 1 {
		return ErrBadProof
	}
	peer, err := ecdh.X25519().NewPublicKey(publicKey)
	if err != nil {
		return ErrBadProof
	}
	// ECDH fails on a low-order point (an all-zero shared secret).
	shared, err := priv.ECDH(peer)
	if err != nil {
		return ErrBadProof
	}
	if !hmac.Equal(MAC(shared, c.GetNonce()), proof.GetMac()) {
		return ErrBadProof
	}
	return nil
}

// MAC is the answer to a challenge: HMAC-SHA256 keyed by the X25519 shared
// secret, over the nonce.
func MAC(shared, nonce []byte) []byte {
	m := hmac.New(sha256.New, shared)
	m.Write(nonce)
	return m.Sum(nil)
}

func (i *Issuer) serverKey(purpose Purpose, nonce []byte, expires int64) (*ecdh.PrivateKey, error) {
	m := hmac.New(sha256.New, i.secret)
	m.Write([]byte(label))
	m.Write([]byte{0})
	m.Write([]byte(purpose))
	m.Write([]byte{0})
	m.Write(nonce)
	var exp [8]byte
	binary.BigEndian.PutUint64(exp[:], uint64(expires))
	m.Write(exp[:])
	priv, err := ecdh.X25519().NewPrivateKey(m.Sum(nil))
	if err != nil {
		return nil, fmt.Errorf("keyproof: server key: %w", err)
	}
	return priv, nil
}
