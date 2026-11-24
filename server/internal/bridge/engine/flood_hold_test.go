package engine

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"testing"
	"time"

	"app.local/server/internal/bridge"
)

// quietRunner is a runner with no engine behind it, for the hold logic alone.
func quietRunner() *runner {
	return &runner{logger: slog.New(slog.NewTextHandler(io.Discard, nil)), refusedUntil: map[string]time.Time{}}
}

func TestALongWaitIsReturnedNotSleptAndAShortOneIsSlept(t *testing.T) {
	calls := 0
	long := &bridge.RateLimitError{RetryAfter: maxInlineWait + time.Hour}
	start := time.Now()
	_, err := retryRateLimit(context.Background(), func() (int, error) { calls++; return 0, long })
	var got *bridge.RateLimitError
	if !errors.As(err, &got) || got != long || calls != 1 {
		t.Fatalf("got err=%v calls=%d, want the wait handed back after one call", err, calls)
	}
	if time.Since(start) > time.Second {
		t.Fatalf("a long wait was slept for %v", time.Since(start))
	}

	calls = 0
	_, err = retryRateLimit(context.Background(), func() (int, error) {
		calls++
		if calls == 1 {
			return 0, &bridge.RateLimitError{RetryAfter: 10 * time.Millisecond}
		}
		return 7, nil
	})
	if err != nil || calls != 2 {
		t.Fatalf("a short wait: err=%v calls=%d, want one retry", err, calls)
	}
}

func TestSkipBusyHoldsTheWaitAndSkipsTheRound(t *testing.T) {
	r := quietRunner()
	if r.floodHeld() {
		t.Fatal("held before any wait")
	}
	if err := r.skipBusy(&bridge.RateLimitError{RetryAfter: time.Hour}, "sync", ""); err != nil {
		t.Fatalf("a wait must skip the round, got %v", err)
	}
	if !r.floodHeld() {
		t.Fatal("the wait was not held")
	}
	// a shorter wait must not shorten the one already held
	until := r.floodUntil
	_ = r.skipBusy(&bridge.RateLimitError{RetryAfter: time.Second}, "sync", "")
	if !r.floodUntil.Equal(until) {
		t.Error("a shorter wait moved the hold")
	}
	boom := errors.New("network down")
	if err := r.skipBusy(fmt.Errorf("x: %w", boom), "sync", ""); !errors.Is(err, boom) {
		t.Fatalf("another error must come back, got %v", err)
	}
}
