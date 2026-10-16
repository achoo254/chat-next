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

func TestRotation(t *testing.T) {
	prev := bytes.Repeat([]byte{8}, 32)
	old, _ := New(prev, "refresh-token")
	sealedOld := old.Seal([]byte("secret"), []byte("row-1"))

	rotated, err := New(master, "refresh-token", prev)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := rotated.Open(sealedOld, []byte("row-1")); err != nil || string(got) != "secret" {
		t.Fatalf("previous master: %q, %v", got, err)
	}
	if !rotated.Stale(sealedOld) || old.Stale(sealedOld) {
		t.Fatal("staleness of a value under the previous master")
	}
	moved, changed, err := rotated.Reseal(sealedOld, []byte("row-1"))
	if err != nil || !changed || rotated.Stale(moved) {
		t.Fatalf("reseal: changed %v, err %v", changed, err)
	}
	if again, changed, err := rotated.Reseal(moved, []byte("row-1")); err != nil || changed || !bytes.Equal(again, moved) {
		t.Fatalf("reseal of a current value: changed %v, err %v", changed, err)
	}
	// Once the previous master is dropped, only resealed values open.
	current, _ := New(master, "refresh-token", nil)
	if _, err := current.Open(sealedOld, []byte("row-1")); !errors.Is(err, ErrOpen) {
		t.Fatalf("dropped master still opens: %v", err)
	}
	if got, err := current.Open(moved, []byte("row-1")); err != nil || string(got) != "secret" {
		t.Fatalf("resealed value: %q, %v", got, err)
	}
	if _, _, err := current.Reseal(sealedOld, []byte("row-1")); !errors.Is(err, ErrOpen) {
		t.Fatalf("reseal of an unreadable value: %v", err)
	}
}

// Values sealed before key ids were added still open, and are stale.
func TestLegacyFormat(t *testing.T) {
	prev := bytes.Repeat([]byte{8}, 32)
	for name, legacyMaster := range map[string][]byte{"current": master, "previous": prev} {
		lk, err := newKey(legacyMaster, "refresh-token")
		if err != nil {
			t.Fatal(err)
		}
		for first := range 256 {
			nonce := make([]byte, lk.aead.NonceSize())
			nonce[0] = byte(first) // includes the format byte
			legacy := lk.aead.Seal(bytes.Clone(nonce), nonce, []byte("secret"), []byte("row-1"))
			b, _ := New(master, "refresh-token", prev)
			if got, err := b.Open(legacy, []byte("row-1")); err != nil || string(got) != "secret" {
				t.Fatalf("%s, nonce[0]=%d: %q, %v", name, first, got, err)
			}
			if !b.Stale(legacy) {
				t.Fatalf("%s: a legacy value is current", name)
			}
		}
	}
}
