// Package sealbox encrypts small secrets with AES-256-GCM. Each Box uses its
// own key derived with HKDF-SHA256 from the master SESSION_KEY and a purpose
// label, so a ciphertext sealed for one purpose (the login cookie) never
// opens as another (a stored refresh token).
package sealbox

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
)

// ErrOpen reports a ciphertext that is malformed, was sealed with another
// key or purpose, or was tampered with.
var ErrOpen = errors.New("sealbox: cannot open")

// Box seals and opens values for one purpose.
type Box struct {
	aead cipher.AEAD
}

// New derives the key of purpose from master (at least 32 bytes).
func New(master []byte, purpose string) (*Box, error) {
	if len(master) < 32 {
		return nil, errors.New("sealbox: master key shorter than 32 bytes")
	}
	key, err := hkdf.Key(sha256.New, master, nil, "chat sealbox v1: "+purpose, 32)
	if err != nil {
		return nil, fmt.Errorf("sealbox: derive key: %w", err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("sealbox: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("sealbox: %w", err)
	}
	return &Box{aead: aead}, nil
}

// Seal encrypts plaintext bound to aad (which must be given again to Open)
// and returns nonce || ciphertext.
func (b *Box) Seal(plaintext, aad []byte) []byte {
	nonce := make([]byte, b.aead.NonceSize(), b.aead.NonceSize()+len(plaintext)+b.aead.Overhead())
	if _, err := rand.Read(nonce); err != nil {
		// crypto/rand does not fail on supported platforms.
		panic(err)
	}
	return b.aead.Seal(nonce, nonce, plaintext, aad)
}

// Open decrypts a value produced by Seal with the same aad.
func (b *Box) Open(sealed, aad []byte) ([]byte, error) {
	n := b.aead.NonceSize()
	if len(sealed) < n+b.aead.Overhead() {
		return nil, ErrOpen
	}
	plain, err := b.aead.Open(nil, sealed[:n], sealed[n:], aad)
	if err != nil {
		return nil, ErrOpen
	}
	return plain, nil
}
