package ratelimit

import (
	"testing"
	"time"
)

func TestMemoryBurstThenRefill(t *testing.T) {
	m := NewMemory()
	clock := time.Unix(1000, 0)
	m.now = func() time.Time { return clock }
	rule := Rule{Rate: 2, Burst: 3}
	for i := range 3 {
		if !m.Allow(rule, "u1") {
			t.Fatalf("token %d refused", i)
		}
	}
	if m.Allow(rule, "u1") {
		t.Fatal("burst exceeded but allowed")
	}
	if !m.Allow(rule, "u2") {
		t.Fatal("other key shares the bucket")
	}
	clock = clock.Add(500 * time.Millisecond) // one token at 2/s
	if !m.Allow(rule, "u1") || m.Allow(rule, "u1") {
		t.Fatal("refill after 500ms should allow exactly one")
	}
}

func TestMemorySweepDropsFullIdleBuckets(t *testing.T) {
	m := NewMemory()
	clock := time.Unix(1000, 0)
	m.now = func() time.Time { return clock }
	rule := Rule{Rate: 1, Burst: 2}
	m.Allow(rule, "a")
	m.Allow(rule, "b")
	m.Allow(rule, "b")
	clock = clock.Add(time.Second)
	m.Sweep(time.Second) // a is full again, b still refilling
	if m.Len() != 1 {
		t.Fatalf("Len = %d, want 1", m.Len())
	}
	clock = clock.Add(5 * time.Second)
	m.Sweep(time.Second)
	if m.Len() != 0 {
		t.Fatalf("Len = %d, want 0", m.Len())
	}
}
