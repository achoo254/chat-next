package auth

import (
	"testing"

	"app.local/server/internal/ratelimit"
)

func TestAdmitSignupCapsPerAddressAndTenant(t *testing.T) {
	h := &Routes{cfg: RoutesConfig{Limiter: ratelimit.NewMemory(), SignupsPerIPHour: 2, SignupsPer10Min: 3}}
	for i := range 2 {
		if !h.admitSignup("192.0.2.1") {
			t.Fatalf("sign-up %d of an address refused", i+1)
		}
	}
	if h.admitSignup("192.0.2.1") {
		t.Fatal("third sign-up of an address in the hour admitted")
	}
	if !h.admitSignup("192.0.2.2") {
		t.Fatal("another address refused")
	}
	if h.admitSignup("192.0.2.3") {
		t.Fatal("tenant cap exceeded")
	}
	off := &Routes{cfg: RoutesConfig{Limiter: ratelimit.NewMemory()}}
	for range 50 {
		if !off.admitSignup("192.0.2.1") {
			t.Fatal("0 caps must turn the limit off")
		}
	}
}

func TestSignupLimitCountsIPv6ByNetwork(t *testing.T) {
	h := &Routes{cfg: RoutesConfig{Limiter: ratelimit.NewMemory(), SignupsPerIPHour: 1}}
	if !h.admitSignup("2001:db8:1:2::1") {
		t.Fatal("first sign-up refused")
	}
	if h.admitSignup("2001:db8:1:2::ffff") {
		t.Fatal("another address of the same /64 admitted")
	}
	if !h.admitSignup("2001:db8:1:3::1") {
		t.Fatal("another /64 refused")
	}
}
