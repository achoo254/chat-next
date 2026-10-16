// Package sealbox encrypts small secrets with AES-256-GCM. Each Box uses its
// own key derived with HKDF-SHA256 from the master SESSION_KEY and a purpose
// label, so a ciphertext sealed for one purpose (the login cookie) never
// opens as another (a stored refresh token).
//
// Key rotation: a Box seals with the current master and opens with the
// current or the previous one (SESSION_KEY_PREVIOUS). A sealed value names
// its master by a key id:
//
//	format (1 byte) || key id (4 bytes) || nonce || ciphertext
//
// Values sealed before key ids existed are nonce || ciphertext; they still
// open (each master is tried) and count as stale. Stale tells the caller to
// seal a value again under the current master, and the server role reseal
// does so for every stored value (docs/operations/key-rotation.md).
package sealbox

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
)

// ErrOpen reports a ciphertext that is malformed, was sealed with another
// key or purpose, or was tampered with.
var ErrOpen = errors.New("sealbox: cannot open")

const (
	format    = 0xA1
	keyIDLen  = 4
	headerLen = 1 + keyIDLen
)

// Box seals and opens values for one purpose.
type Box struct {
	keys []boxKey // current first
}

type boxKey struct {
	id   []byte
	aead cipher.AEAD
}

// New derives the key of purpose from master (at least 32 bytes), and from
// previous masters that may still open older values. Empty previous masters
// are ignored.
func New(master []byte, purpose string, previous ...[]byte) (*Box, error) {
	b := &Box{}
	for i, m := range append([][]byte{master}, previous...) {
		if i > 0 && len(m) == 0 {
			continue
		}
		k, err := newKey(m, purpose)
		if err != nil {
			return nil, err
		}
		b.keys = append(b.keys, k)
	}
	return b, nil
}

func newKey(master []byte, purpose string) (boxKey, error) {
	if len(master) < 32 {
		return boxKey{}, errors.New("sealbox: master key shorter than 32 bytes")
	}
	key, err := hkdf.Key(sha256.New, master, nil, "chat sealbox v1: "+purpose, 32)
	if err != nil {
		return boxKey{}, fmt.Errorf("sealbox: derive key: %w", err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return boxKey{}, fmt.Errorf("sealbox: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return boxKey{}, fmt.Errorf("sealbox: %w", err)
	}
	return boxKey{id: KeyID(master), aead: aead}, nil
}

// KeyID names master without revealing it; the runbook compares it with
// the id the reseal role reports.
func KeyID(master []byte) []byte {
	mac := hmac.New(sha256.New, master)
	mac.Write([]byte("chat sealbox key id"))
	return mac.Sum(nil)[:keyIDLen]
}

// Seal encrypts plaintext bound to aad (which must be given again to Open)
// under the current master.
func (b *Box) Seal(plaintext, aad []byte) []byte {
	k := b.keys[0]
	n := k.aead.NonceSize()
	out := make([]byte, headerLen+n, headerLen+n+len(plaintext)+k.aead.Overhead())
	out[0] = format
	copy(out[1:headerLen], k.id)
	if _, err := rand.Read(out[headerLen:]); err != nil {
		// crypto/rand does not fail on supported platforms.
		panic(err)
	}
	return k.aead.Seal(out, out[headerLen:], plaintext, aad)
}

// Open decrypts a value produced by Seal with the same aad, under the
// current or a previous master.
func (b *Box) Open(sealed, aad []byte) ([]byte, error) {
	if len(sealed) > headerLen && sealed[0] == format {
		for _, k := range b.keys {
			if bytes.Equal(sealed[1:headerLen], k.id) {
				if plain, err := k.open(sealed[headerLen:], aad); err == nil {
					return plain, nil
				}
			}
		}
	}
	// A value sealed before key ids (its first nonce byte may equal format).
	for _, k := range b.keys {
		if plain, err := k.open(sealed, aad); err == nil {
			return plain, nil
		}
	}
	return nil, ErrOpen
}

// Stale reports whether sealed is not under the current master: Seal it
// again once Open succeeded.
func (b *Box) Stale(sealed []byte) bool {
	return len(sealed) <= headerLen || sealed[0] != format || !bytes.Equal(sealed[1:headerLen], b.keys[0].id)
}

func (k boxKey) open(sealed, aad []byte) ([]byte, error) {
	n := k.aead.NonceSize()
	if len(sealed) < n+k.aead.Overhead() {
		return nil, ErrOpen
	}
	plain, err := k.aead.Open(nil, sealed[:n], sealed[n:], aad)
	if err != nil {
		return nil, ErrOpen
	}
	return plain, nil
}

// Reseal returns sealed under the current master; changed is false when it
// already was.
func (b *Box) Reseal(sealed, aad []byte) (out []byte, changed bool, err error) {
	if !b.Stale(sealed) {
		return sealed, false, nil
	}
	plain, err := b.Open(sealed, aad)
	if err != nil {
		return nil, false, err
	}
	return b.Seal(plain, aad), true, nil
}

// Count tallies a run that reseals stored values. A value that changed
// between its read and its write (a process resealed it on use, an owner
// replaced it) is left to that change and not counted.
type Count struct {
	Resealed   int // moved to the current master
	Current    int // already under it
	Unreadable int // opened under no configured master; left as they are
}
