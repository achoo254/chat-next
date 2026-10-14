package sealbox

import (
	"bytes"
	"errors"
	"testing"
)

var master = bytes.Repeat([]byte{7}, 32)

func TestSealOpen(t *testing.T) {
	b, err := New(master, "refresh-token")
	if err != nil {
		t.Fatal(err)
	}
	sealed := b.Seal([]byte("secret"), []byte("row-1"))
	if bytes.Contains(sealed, []byte("secret")) {
		t.Fatal("plaintext visible in ciphertext")
	}
	got, err := b.Open(sealed, []byte("row-1"))
	if err != nil || string(got) != "secret" {
		t.Fatalf("Open = %q, %v", got, err)
	}
	if again := b.Seal([]byte("secret"), []byte("row-1")); bytes.Equal(again, sealed) {
		t.Fatal("nonce reused")
	}
}

func TestOpenRejects(t *testing.T) {
	b, _ := New(master, "refresh-token")
	other, _ := New(master, "login-cookie")
	sealed := b.Seal([]byte("secret"), []byte("row-1"))

	tampered := bytes.Clone(sealed)
	tampered[len(tampered)-1] ^= 1
	for name, open := range map[string]func() ([]byte, error){
		"wrong aad":     func() ([]byte, error) { return b.Open(sealed, []byte("row-2")) },
		"wrong purpose": func() ([]byte, error) { return other.Open(sealed, []byte("row-1")) },
		"tampered":      func() ([]byte, error) { return b.Open(tampered, []byte("row-1")) },
		"short":         func() ([]byte, error) { return b.Open(sealed[:5], []byte("row-1")) },
	} {
		if _, err := open(); !errors.Is(err, ErrOpen) {
			t.Errorf("%s: err = %v", name, err)
		}
	}
}

func TestNewRejectsShortKey(t *testing.T) {
	if _, err := New(make([]byte, 31), "x"); err == nil {
		t.Fatal("short key accepted")
	}
}
