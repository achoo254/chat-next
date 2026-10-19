package ids

import (
	"errors"
	"sync"
	"testing"
	"time"
)

// fakeClock is a manually driven millisecond clock; sleeping advances it.
type fakeClock struct {
	mu    sync.Mutex
	ms    int64
	slept []time.Duration
}

func (c *fakeClock) now() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ms
}

func (c *fakeClock) sleep(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.slept = append(c.slept, d)
	step := d.Milliseconds()
	if step < 1 {
		step = 1
	}
	c.ms += step
}

func (c *fakeClock) set(ms int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.ms = ms
}

func newTestSnowflake(t *testing.T, worker int64, clock *fakeClock) *Snowflake {
	t.Helper()
	g, err := NewSnowflake(worker)
	if err != nil {
		t.Fatalf("NewSnowflake(%d): %v", worker, err)
	}
	g.now = clock.now
	g.sleep = clock.sleep
	return g
}

func decompose(id int64) (ms, worker, sequence int64) {
	return id >> 22, id >> 12 & MaxWorker, id & maxSnowflakeSequence
}

func mustNext(t *testing.T, g *Snowflake) int64 {
	t.Helper()
	id, err := g.Next()
	if err != nil {
		t.Fatalf("Next: %v", err)
	}
	return id
}

func TestSnowflakeLayout(t *testing.T) {
	epoch := SnowflakeEpoch.UnixMilli()
	clock := &fakeClock{ms: epoch + 1234}
	g := newTestSnowflake(t, 77, clock)

	first := mustNext(t, g)
	second := mustNext(t, g)
	if ms, worker, seq := decompose(first); ms != 1234 || worker != 77 || seq != 0 {
		t.Errorf("first id fields = (%d, %d, %d), want (1234, 77, 0)", ms, worker, seq)
	}
	if ms, worker, seq := decompose(second); ms != 1234 || worker != 77 || seq != 1 {
		t.Errorf("second id fields = (%d, %d, %d), want (1234, 77, 1)", ms, worker, seq)
	}

	clock.set(epoch + 1235)
	if _, _, seq := decompose(mustNext(t, g)); seq != 0 {
		t.Errorf("sequence did not reset on a new millisecond: %d", seq)
	}
}

func TestSnowflakeEpochAndRange(t *testing.T) {
	if got := SnowflakeEpoch.Format(time.RFC3339); got != "2026-01-01T00:00:00Z" {
		t.Fatalf("SnowflakeEpoch = %s", got)
	}
	epoch := SnowflakeEpoch.UnixMilli()

	g := newTestSnowflake(t, 0, &fakeClock{ms: epoch - 1})
	if _, err := g.Next(); !errors.Is(err, ErrClockOutOfRange) {
		t.Errorf("before epoch: error = %v, want ErrClockOutOfRange", err)
	}

	g = newTestSnowflake(t, MaxWorker, &fakeClock{ms: epoch + maxSnowflakeTime})
	id := mustNext(t, g)
	if id <= 0 {
		t.Errorf("largest id must stay positive in 63 bits, got %d", id)
	}

	g = newTestSnowflake(t, 0, &fakeClock{ms: epoch + maxSnowflakeTime + 1})
	if _, err := g.Next(); !errors.Is(err, ErrClockOutOfRange) {
		t.Errorf("after time field overflow: error = %v, want ErrClockOutOfRange", err)
	}
}

func TestNewSnowflakeRejectsBadWorker(t *testing.T) {
	for _, w := range []int64{-1, MaxWorker + 1} {
		if _, err := NewSnowflake(w); !errors.Is(err, ErrOutOfRange) {
			t.Errorf("NewSnowflake(%d) error = %v, want ErrOutOfRange", w, err)
		}
	}
}

func TestSnowflakeSequenceExhaustionWaitsForNextMillisecond(t *testing.T) {
	epoch := SnowflakeEpoch.UnixMilli()
	clock := &fakeClock{ms: epoch + 10}
	g := newTestSnowflake(t, 1, clock)

	var last int64
	for i := int64(0); i <= maxSnowflakeSequence; i++ {
		id := mustNext(t, g)
		if id <= last {
			t.Fatalf("id %d not greater than %d", id, last)
		}
		last = id
	}
	if len(clock.slept) != 0 {
		t.Fatalf("slept before the sequence was exhausted")
	}
	next := mustNext(t, g)
	if ms, _, seq := decompose(next); ms != 11 || seq != 0 || next <= last {
		t.Errorf("after exhaustion got ms=%d seq=%d, want ms=11 seq=0", ms, seq)
	}
	if len(clock.slept) == 0 {
		t.Errorf("expected a wait for the next millisecond")
	}
}

func TestSnowflakeSmallClockRollbackWaits(t *testing.T) {
	epoch := SnowflakeEpoch.UnixMilli()
	clock := &fakeClock{ms: epoch + 5000}
	g := newTestSnowflake(t, 2, clock)
	before := mustNext(t, g)

	clock.set(epoch + 4800) // 200 ms backwards
	after := mustNext(t, g)
	if after <= before {
		t.Fatalf("id after rollback %d not greater than %d", after, before)
	}
	if len(clock.slept) == 0 || clock.slept[0] != 200*time.Millisecond {
		t.Errorf("expected a 200ms wait, got %v", clock.slept)
	}
}

func TestSnowflakeLargeClockRollbackFails(t *testing.T) {
	epoch := SnowflakeEpoch.UnixMilli()
	clock := &fakeClock{ms: epoch + 10_000}
	g := newTestSnowflake(t, 3, clock)
	mustNext(t, g)

	clock.set(epoch + 10_000 - MaxClockRollback.Milliseconds() - 1)
	if _, err := g.Next(); !errors.Is(err, ErrClockMovedBackwards) {
		t.Fatalf("error = %v, want ErrClockMovedBackwards", err)
	}
	clock.set(epoch + 10_001)
	mustNext(t, g) // recovers once the clock is ahead again
}

func TestSnowflakeConcurrentUniqueAndOrdered(t *testing.T) {
	g, err := NewSnowflake(42)
	if err != nil {
		t.Fatal(err)
	}
	const goroutines = 16
	const perGoroutine = 5000

	results := make([][]int64, goroutines)
	var wg sync.WaitGroup
	for i := range goroutines {
		wg.Go(func() {
			ids := make([]int64, 0, perGoroutine)
			for range perGoroutine {
				id, err := g.Next()
				if err != nil {
					t.Errorf("Next: %v", err)
					return
				}
				ids = append(ids, id)
			}
			results[i] = ids
		})
	}
	wg.Wait()

	seen := make(map[int64]struct{}, goroutines*perGoroutine)
	for _, ids := range results {
		for j, id := range ids {
			if j > 0 && id <= ids[j-1] {
				t.Fatalf("ids of one goroutine not increasing: %d then %d", ids[j-1], id)
			}
			if _, dup := seen[id]; dup {
				t.Fatalf("duplicate id %d", id)
			}
			seen[id] = struct{}{}
			if _, worker, _ := decompose(id); worker != 42 {
				t.Fatalf("id %d has worker %d", id, worker)
			}
		}
	}
	if len(seen) != goroutines*perGoroutine {
		t.Fatalf("got %d unique ids, want %d", len(seen), goroutines*perGoroutine)
	}
}

func TestMonotonicMillisAdvancesFromItsAnchor(t *testing.T) {
	start := time.Now()
	clock := monotonicMillis(start)
	first := clock()
	if first < start.UnixMilli() {
		t.Fatalf("clock %d starts before its anchor %d", first, start.UnixMilli())
	}
	time.Sleep(2 * time.Millisecond)
	if second := clock(); second < first+2 {
		t.Errorf("clock advanced from %d to %d, want at least 2 ms", first, second)
	}
}

func TestNewSnowflakeAfterStartsLater(t *testing.T) {
	now := time.Now().UnixMilli()
	g, err := NewSnowflakeAfter(3, now+20)
	if err != nil {
		t.Fatal(err)
	}
	if got := g.LastUnixMs(); got != now+20 {
		t.Fatalf("LastUnixMs = %d, want %d", got, now+20)
	}
	id, err := g.Next()
	if err != nil {
		t.Fatal(err)
	}
	ms := id>>(snowflakeWorkerBits+snowflakeSequenceBits) + SnowflakeEpoch.UnixMilli()
	if ms <= now+20 {
		t.Fatalf("first id at ms %d, want after %d", ms, now+20)
	}
	fresh, err := NewSnowflake(3)
	if err != nil {
		t.Fatal(err)
	}
	if fresh.LastUnixMs() != 0 {
		t.Fatalf("fresh LastUnixMs = %d", fresh.LastUnixMs())
	}
}

// The ids of a time range lie between the floors of its ends, whatever the
// worker and sequence.
func TestSnowflakeFloor(t *testing.T) {
	epoch := SnowflakeEpoch.UnixMilli()
	clock := &fakeClock{ms: epoch + 5000}
	g := newTestSnowflake(t, MaxWorker, clock)
	id := mustNext(t, g)
	at := time.UnixMilli(epoch + 5000)
	if lo, hi := SnowflakeFloor(at), SnowflakeFloor(at.Add(time.Millisecond)); id < lo || id >= hi {
		t.Fatalf("id %d outside [%d, %d)", id, lo, hi)
	}
	if got := SnowflakeFloor(SnowflakeEpoch.Add(-time.Hour)); got != 0 {
		t.Fatalf("floor before the epoch = %d, want 0", got)
	}
}
