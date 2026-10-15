// Package webpush implements the sending side of the Web Push protocol:
// message encryption (RFC 8291, aes128gcm content coding of RFC 8188),
// VAPID authentication (RFC 8292) and the check of the endpoints browsers
// hand out (endpoint.go). It knows nothing about chats; package push
// decides what to send to whom.
package webpush

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

// Sizes of the RFC 8291 keys and of one push message.
const (
	// PublicKeyLen is an uncompressed P-256 point (p256dh, VAPID key).
	PublicKeyLen = 65
	// AuthLen is the browser's authentication secret.
	AuthLen = 16
	// MessageMax is the most a push service must accept as a message body
	// (RFC 8291 section 4); the encrypted header takes 86 of them.
	MessageMax = 4096
	saltLen    = 16
	headerLen  = saltLen + 4 + 1 + PublicKeyLen
	tagLen     = 16
	// PayloadMax is the longest plaintext one message carries: one record
	// holds the payload, the 0x02 delimiter and the GCM tag.
	PayloadMax = MessageMax - headerLen - 1 - tagLen
)

// ErrPayloadTooLarge is returned for a payload above PayloadMax.
var ErrPayloadTooLarge = errors.New("webpush: payload too large")

// Keys are a subscription's keys as the browser reports them.
type Keys struct {
	// P256DH is the browser's public key, an uncompressed P-256 point.
	P256DH []byte
	// Auth is the authentication secret.
	Auth []byte
}

// Validate reports whether the keys have the right sizes and the public
// key is a point of P-256.
func (k Keys) Validate() error {
	if len(k.Auth) != AuthLen {
		return fmt.Errorf("webpush: auth secret must be %d bytes", AuthLen)
	}
	if len(k.P256DH) != PublicKeyLen {
		return fmt.Errorf("webpush: p256dh must be %d bytes", PublicKeyLen)
	}
	if _, err := ecdh.P256().NewPublicKey(k.P256DH); err != nil {
		return errors.New("webpush: p256dh is not a P-256 public key")
	}
	return nil
}

// Encrypt encrypts payload for the browser with keys (one aes128gcm
// record). The plaintext is padded with zeros to a multiple of padTo bytes
// (at most PayloadMax), so the size on the wire hides the exact length of
// the message; padTo 0 or 1 adds no padding.
func Encrypt(payload []byte, keys Keys, padTo int) ([]byte, error) {
	ephemeral, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("webpush: ephemeral key: %w", err)
	}
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return nil, fmt.Errorf("webpush: salt: %w", err)
	}
	return encrypt(payload, keys, ephemeral, salt, padTo)
}

// encrypt is Encrypt with the ephemeral key and salt given (the RFC 8291
// example uses fixed ones).
func encrypt(payload []byte, keys Keys, ephemeral *ecdh.PrivateKey, salt []byte, padTo int) ([]byte, error) {
	if len(payload) > PayloadMax {
		return nil, ErrPayloadTooLarge
	}
	if err := keys.Validate(); err != nil {
		return nil, err
	}
	uaPublic, err := ecdh.P256().NewPublicKey(keys.P256DH)
	if err != nil {
		return nil, errors.New("webpush: p256dh is not a P-256 public key")
	}
	ecdhSecret, err := ephemeral.ECDH(uaPublic)
	if err != nil {
		return nil, fmt.Errorf("webpush: key agreement: %w", err)
	}
	asPublic := ephemeral.PublicKey().Bytes()

	// RFC 8291 section 3.4: combine the shared secret with the auth secret.
	prkKey, err := hkdf.Extract(sha256.New, ecdhSecret, keys.Auth)
	if err != nil {
		return nil, err
	}
	keyInfo := make([]byte, 0, 14+2*PublicKeyLen)
	keyInfo = append(keyInfo, "WebPush: info\x00"...)
	keyInfo = append(keyInfo, keys.P256DH...)
	keyInfo = append(keyInfo, asPublic...)
	ikm, err := hkdf.Expand(sha256.New, prkKey, string(keyInfo), 32)
	if err != nil {
		return nil, err
	}
	// RFC 8188 section 2.2: content encryption key and nonce from the salt.
	prk, err := hkdf.Extract(sha256.New, ikm, salt)
	if err != nil {
		return nil, err
	}
	cek, err := hkdf.Expand(sha256.New, prk, "Content-Encoding: aes128gcm\x00", 16)
	if err != nil {
		return nil, err
	}
	nonce, err := hkdf.Expand(sha256.New, prk, "Content-Encoding: nonce\x00", 12)
	if err != nil {
		return nil, err
	}

	plain := make([]byte, 0, paddedLen(len(payload), padTo))
	plain = append(plain, payload...)
	plain = append(plain, 0x02) // delimiter of the last (only) record
	plain = append(plain, make([]byte, paddedLen(len(payload), padTo)-len(plain))...)

	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	var out bytes.Buffer
	out.Grow(headerLen + len(plain) + tagLen)
	out.Write(salt)
	_ = binary.Write(&out, binary.BigEndian, uint32(MessageMax))
	out.WriteByte(PublicKeyLen)
	out.Write(asPublic)
	out.Write(gcm.Seal(nil, nonce, plain, nil))
	return out.Bytes(), nil
}

// paddedLen is the plaintext record length (payload and delimiter) after
// padding to a multiple of padTo, capped so the message fits MessageMax.
func paddedLen(payloadLen, padTo int) int {
	n := payloadLen + 1
	if padTo > 1 && n%padTo != 0 {
		n += padTo - n%padTo
	}
	return min(n, PayloadMax+1)
}
