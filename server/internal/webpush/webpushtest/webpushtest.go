// Package webpushtest plays the browser side of Web Push in tests: a
// subscription's keys and RFC 8291 decryption of the messages a push
// service would hand the browser.
package webpushtest

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
)

// Browser holds a subscription's private key and secret.
type Browser struct {
	Private *ecdh.PrivateKey
	// P256DH and Auth are what PushSubscription.getKey returns.
	P256DH, Auth []byte
}

// NewBrowser returns fresh subscription keys.
func NewBrowser() (Browser, error) {
	private, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return Browser{}, err
	}
	auth := make([]byte, 16)
	if _, err := rand.Read(auth); err != nil {
		return Browser{}, err
	}
	return Browser{Private: private, P256DH: private.PublicKey().Bytes(), Auth: auth}, nil
}

// Header is the aes128gcm header of a message.
type Header struct {
	RecordSize uint32
	KeyIDLen   int
}

// Decrypt decrypts one aes128gcm message (a single record) and returns the
// payload without the delimiter and padding, with the header it read.
func (b Browser) Decrypt(message []byte) ([]byte, Header, error) {
	if len(message) < 21 {
		return nil, Header{}, errors.New("webpushtest: message shorter than its header")
	}
	salt := message[:16]
	h := Header{RecordSize: binary.BigEndian.Uint32(message[16:20]), KeyIDLen: int(message[20])}
	if len(message) < 21+h.KeyIDLen {
		return nil, h, errors.New("webpushtest: truncated key id")
	}
	asPublic, err := ecdh.P256().NewPublicKey(message[21 : 21+h.KeyIDLen])
	if err != nil {
		return nil, h, fmt.Errorf("webpushtest: sender key: %w", err)
	}
	secret, err := b.Private.ECDH(asPublic)
	if err != nil {
		return nil, h, err
	}
	prkKey, err := hkdf.Extract(sha256.New, secret, b.Auth)
	if err != nil {
		return nil, h, err
	}
	info := append(append([]byte("WebPush: info\x00"), b.P256DH...), asPublic.Bytes()...)
	ikm, err := hkdf.Expand(sha256.New, prkKey, string(info), 32)
	if err != nil {
		return nil, h, err
	}
	prk, err := hkdf.Extract(sha256.New, ikm, salt)
	if err != nil {
		return nil, h, err
	}
	cek, err := hkdf.Expand(sha256.New, prk, "Content-Encoding: aes128gcm\x00", 16)
	if err != nil {
		return nil, h, err
	}
	nonce, err := hkdf.Expand(sha256.New, prk, "Content-Encoding: nonce\x00", 12)
	if err != nil {
		return nil, h, err
	}
	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, h, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, h, err
	}
	plain, err := gcm.Open(nil, nonce, message[21+h.KeyIDLen:], nil)
	if err != nil {
		return nil, h, fmt.Errorf("webpushtest: decrypt: %w", err)
	}
	end := bytes.LastIndexByte(plain, 0x02)
	if end < 0 || !bytes.Equal(plain[end+1:], make([]byte, len(plain)-end-1)) {
		return nil, h, errors.New("webpushtest: no record delimiter, or padding that is not zeros")
	}
	return plain[:end], h, nil
}
