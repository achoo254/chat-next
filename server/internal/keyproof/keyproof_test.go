package keyproof

import (
	"bytes"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"google.golang.org/protobuf/proto"
)

func newIssuer(t *testing.T) (*Issuer, *time.Time) {
	t.Helper()
	i, err := New(bytes.Repeat([]byte{9}, 32))
	if err != nil {
		t.Fatal(err)
	}
	clock := time.Unix(1_800_000_000, 0)
	i.SetClock(func() time.Time { return clock })
	return i, &clock
}

func newKey(t *testing.T) *ecdh.PrivateKey {
	t.Helper()
	k, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

// answer computes the proof as a client does.
func answer(t *testing.T, key *ecdh.PrivateKey, c *appv1.KeyChallenge) *appv1.KeyProof {
	t.Helper()
	server, err := ecdh.X25519().NewPublicKey(c.GetServerKey())
	if err != nil {
		t.Fatal(err)
	}
	shared, err := key.ECDH(server)
	if err != nil {
		t.Fatal(err)
	}
	return &appv1.KeyProof{Challenge: c, Mac: MAC(shared, c.GetNonce())}
}

func TestProofChecks(t *testing.T) {
	i, clock := newIssuer(t)
	key := newKey(t)
	c, err := i.Challenge(AccountDevice)
	if err != nil {
		t.Fatal(err)
	}
	if len(c.GetServerKey()) != 32 || len(c.GetNonce()) != 32 || c.GetExpiresAt() != clock.Add(TTL).Unix() {
		t.Fatalf("challenge %+v", c)
	}
	proof := answer(t, key, c)
	if err := i.Verify(AccountDevice, key.PublicKey().Bytes(), proof); err != nil {
		t.Fatalf("good proof: %v", err)
	}

	bad := func(name string, purpose Purpose, pub []byte, p *appv1.KeyProof) {
		t.Helper()
		if err := i.Verify(purpose, pub, p); !errors.Is(err, ErrBadProof) {
			t.Fatalf("%s: %v", name, err)
		}
	}
	bad("another purpose", Machine, key.PublicKey().Bytes(), proof)
	bad("another key", AccountDevice, newKey(t).PublicKey().Bytes(), proof)
	bad("no proof", AccountDevice, key.PublicKey().Bytes(), nil)
	bad("no challenge", AccountDevice, key.PublicKey().Bytes(), &appv1.KeyProof{Mac: proof.GetMac()})

	flipped := proto.Clone(proof).(*appv1.KeyProof)
	flipped.Mac[0] ^= 1
	bad("wrong mac", AccountDevice, key.PublicKey().Bytes(), flipped)

	// A client may not choose the challenge: changing any part breaks it.
	moved := proto.Clone(proof).(*appv1.KeyProof)
	moved.Challenge.ExpiresAt--
	bad("changed expiry", AccountDevice, key.PublicKey().Bytes(), moved)
	other := proto.Clone(proof).(*appv1.KeyProof)
	other.Challenge.Nonce[0] ^= 1
	bad("changed nonce", AccountDevice, key.PublicKey().Bytes(), other)
	forged, err := i.Challenge(AccountDevice)
	if err != nil {
		t.Fatal(err)
	}
	swapped := answer(t, key, forged)
	swapped.Challenge.ServerKey = newKey(t).PublicKey().Bytes()
	bad("server key of the caller's choice", AccountDevice, key.PublicKey().Bytes(), answer(t, key, swapped.GetChallenge()))
	bad("low-order key", AccountDevice, make([]byte, 32), proof)

	*clock = clock.Add(TTL)
	bad("expired", AccountDevice, key.PublicKey().Bytes(), proof)
}

func TestFarFutureChallengeIsRefused(t *testing.T) {
	i, clock := newIssuer(t)
	key := newKey(t)
	*clock = clock.Add(time.Hour)
	c, err := i.Challenge(Machine)
	if err != nil {
		t.Fatal(err)
	}
	*clock = clock.Add(-time.Hour)
	if err := i.Verify(Machine, key.PublicKey().Bytes(), answer(t, key, c)); !errors.Is(err, ErrBadProof) {
		t.Fatalf("challenge from the future: %v", err)
	}
}

func TestOtherSecretRefuses(t *testing.T) {
	i, _ := newIssuer(t)
	key := newKey(t)
	c, err := i.Challenge(Machine)
	if err != nil {
		t.Fatal(err)
	}
	j, err := New(bytes.Repeat([]byte{8}, 32))
	if err != nil {
		t.Fatal(err)
	}
	j.SetClock(i.now)
	if err := j.Verify(Machine, key.PublicKey().Bytes(), answer(t, key, c)); !errors.Is(err, ErrBadProof) {
		t.Fatalf("another server secret: %v", err)
	}
	if _, err := New(make([]byte, 31)); err == nil {
		t.Fatal("short secret accepted")
	}
}

// TestVector pins the client's formula; packages/remote-protocol checks the
// same numbers (key-proof.test.ts), so devices, tunelo and the server agree.
func TestVector(t *testing.T) {
	client, err := ecdh.X25519().NewPrivateKey(seq(1))
	if err != nil {
		t.Fatal(err)
	}
	server, err := ecdh.X25519().NewPrivateKey(seq(101))
	if err != nil {
		t.Fatal(err)
	}
	shared, err := client.ECDH(server.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{
		"client public": hex.EncodeToString(client.PublicKey().Bytes()),
		"server public": hex.EncodeToString(server.PublicKey().Bytes()),
		"mac":           hex.EncodeToString(MAC(shared, seq(201))),
	}
	want := map[string]string{
		"client public": vectorClientPublic,
		"server public": vectorServerPublic,
		"mac":           vectorMAC,
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %s, want %s", k, got[k], v)
		}
	}
}

// seq returns 32 bytes counting up from first (mod 256).
func seq(first int) []byte {
	b := make([]byte, 32)
	for i := range b {
		b[i] = byte(first + i)
	}
	return b
}

const (
	vectorClientPublic = "07a37cbc142093c8b755dc1b10e86cb426374ad16aa853ed0bdfc0b2b86d1c7c"
	vectorServerPublic = "5714769d116bf76436ae74bc793d2c30ad1903c59ac5273805c7e2698b410c36"
	vectorMAC          = "289ee0f2dcdf5cb02b6e7a540b3b33e0712573db03375eacda1d277b818b1bfc"
)
