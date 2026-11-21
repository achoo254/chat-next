package zalo

import (
	"sync"
	"testing"
	"time"
)

// fakeClock is a settable time source, safe to read from other goroutines.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func newFakeClock() *fakeClock { return &fakeClock{t: time.Date(2026, 11, 21, 8, 0, 0, 0, time.UTC)} }

func (c *fakeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) set(t time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = t
}

func (c *fakeClock) advance(d time.Duration)               { c.set(c.now().Add(d)) }
func (c *fakeClock) elapsed(since time.Time) time.Duration { return c.now().Sub(since) }
func (c *fakeClock) tracker() *refusalTracker              { return newRefusalTracker(c.now) }

func TestRefusalsInAQuickBurstDoNotRevoke(t *testing.T) {
	c := newFakeClock()
	tr := c.tracker()
	for i := 0; i < 20; i++ { // the engine's backoff: seconds apart
		if revoked, counted := tr.refused("a"); revoked || counted != 1 {
			t.Fatalf("refusal %d: revoked %v, counted %d", i, revoked, counted)
		}
		c.advance(5 * time.Second)
	}
}

func TestRefusalsSpreadOverAnHourRevoke(t *testing.T) {
	c := newFakeClock()
	tr := c.tracker()
	start := c.now()
	var revoked bool
	for !revoked {
		revoked, _ = tr.refused("a")
		if !revoked {
			c.advance(5 * time.Minute) // the engine's longest backoff
		}
		if c.elapsed(start) > 3*time.Hour {
			t.Fatal("never revoked")
		}
	}
	if got := c.elapsed(start); got < revokeMinSpan {
		t.Errorf("revoked after %v, before %v", got, revokeMinSpan)
	}
	if again, counted := tr.refused("a"); again || counted != 1 {
		t.Errorf("the streak was not cleared: %v %d", again, counted)
	}
}

func TestAConnectedListenerClearsTheStreak(t *testing.T) {
	c := newFakeClock()
	tr := c.tracker()
	tr.refused("a")
	c.advance(revokeMinGap)
	tr.refused("a")
	tr.connected("a")
	c.advance(revokeMinGap)
	if _, counted := tr.refused("a"); counted != 1 {
		t.Errorf("counted %d after a connect, want 1", counted)
	}
}

func TestAnOldStreakStartsOver(t *testing.T) {
	c := newFakeClock()
	tr := c.tracker()
	tr.refused("a")
	c.advance(revokeMinGap)
	tr.refused("a")
	c.set(c.now().Add(revokeForgetAfter + time.Minute))
	if revoked, counted := tr.refused("a"); revoked || counted != 1 {
		t.Errorf("old streak: revoked %v, counted %d", revoked, counted)
	}
}

func TestStreaksAreKeptPerAccount(t *testing.T) {
	c := newFakeClock()
	tr := c.tracker()
	tr.refused("a")
	c.advance(revokeMinGap)
	if _, counted := tr.refused("b"); counted != 1 {
		t.Errorf("account b counted %d", counted)
	}
}
