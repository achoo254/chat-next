package zalo

import (
	"errors"
	"testing"
	"time"

	"app.local/server/internal/bridge"
)

func TestOneOpenLoginPerUser(t *testing.T) {
	r := &fakeRunner{script: scriptedQR(t, make(chan string))}
	a, _ := newTestAdapter(t, r)
	if _, err := a.Login(asOwner(1), "", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Login(asOwner(1), "", nil); !errors.Is(err, bridge.ErrLoginLimited) {
		t.Fatalf("second login of the same user: err = %v", err)
	}
	if _, err := a.Login(asOwner(2), "", nil); err != nil {
		t.Fatalf("another user: %v", err)
	}
}

func TestServerWideCapOnLogins(t *testing.T) {
	r := &fakeRunner{script: scriptedQR(t, make(chan string))}
	a, _ := newTestAdapter(t, r)
	for owner := int64(1); owner <= maxConcurrentLogins; owner++ {
		if _, err := a.Login(asOwner(owner), "", nil); err != nil {
			t.Fatalf("login %d: %v", owner, err)
		}
	}
	if _, err := a.Login(asOwner(99), "", nil); !errors.Is(err, bridge.ErrLoginLimited) {
		t.Fatalf("login over the cap: err = %v", err)
	}
	if r.starts() != maxConcurrentLogins {
		t.Errorf("sidecars started = %d, want %d", r.starts(), maxConcurrentLogins)
	}
}

func TestAFailedLoginMakesTheUserWait(t *testing.T) {
	clock := newFakeClock()
	lines := make(chan string, 2)
	r := &fakeRunner{script: scriptedQR(t, lines)}
	a, _ := newTestAdapterAt(t, r, clock.now)
	step, err := a.Login(asOwner(1), "", nil)
	if err != nil {
		t.Fatal(err)
	}
	lines <- `{"ev":"qr_declined"}`
	if _, err := a.Login(asOwner(1), step.Token, nil); !isInputError(err) {
		t.Fatalf("declined: %v", err)
	}
	if _, err := a.Login(asOwner(1), "", nil); !errors.Is(err, bridge.ErrLoginLimited) {
		t.Fatalf("right after a failure: err = %v", err)
	}
	if _, err := a.Login(asOwner(2), "", nil); err != nil {
		t.Fatalf("another user is not held back: %v", err)
	}
	clock.advance(loginRetryGap)
	if _, err := a.Login(asOwner(1), "", nil); err != nil {
		t.Fatalf("after the gap: %v", err)
	}
}

func TestEveryLoginCallStaysUnderTheServerWriteTimeout(t *testing.T) {
	const writeTimeout = 60 * time.Second // internal/api http.Server.WriteTimeout
	if defaultTiming.loginStartWait > 5*time.Second {
		t.Errorf("a login start may take %v", defaultTiming.loginStartWait)
	}
	if defaultTiming.loginPoll > writeTimeout/2 {
		t.Errorf("a poll may take %v, too close to %v", defaultTiming.loginPoll, writeTimeout)
	}
	if defaultTiming.loginIdle <= defaultTiming.loginPoll {
		t.Error("a client that polls without pause would be taken for gone")
	}
}
