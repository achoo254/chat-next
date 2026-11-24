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
	_, err := retryRateLimit(deferLongWaits(context.Background()), func() (int, error) { calls++; return 0, long })
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

func TestOnlyMarkedWorkDefersALongWait(t *testing.T) {
	old := maxInlineWait
	maxInlineWait = 5 * time.Millisecond
	defer func() { maxInlineWait = old }()
	wait := func(ctx context.Context) (calls int, err error) {
		_, err = retryRateLimit(ctx, func() (int, error) {
			calls++
			if calls == 1 {
				return 0, &bridge.RateLimitError{RetryAfter: 30 * time.Millisecond}
			}
			return 1, nil
		})
		return calls, err
	}
	if calls, err := wait(context.Background()); err != nil || calls != 2 {
		t.Fatalf("an event or a send: err=%v calls=%d, want the wait slept and the call made again", err, calls)
	}
	if calls, err := wait(deferLongWaits(context.Background())); err == nil || calls != 1 {
		t.Fatalf("a periodic read: err=%v calls=%d, want the wait handed back", err, calls)
	}
}

func TestAWindowCutShortByAWaitGoesOnFromWhereItStopped(t *testing.T) {
	r := quietRunner()
	l := &chatLink{ID: 7}
	if got, cur, _ := r.takeWindow(l); got != nil || cur != (bridge.Cursor{}) {
		t.Fatal("a window that was never kept came back")
	}
	read := []bridge.Message{{ID: "m9"}, {ID: "m8"}}
	r.keepWindow(l, read, bridge.Cursor{Before: "m8"})
	got, cur, complete := r.takeWindow(l)
	if len(got) != 2 || cur.Before != "m8" || complete {
		t.Fatalf("kept window = %v from %v (complete %v), want the two pages read and the cursor after them", got, cur, complete)
	}
	if again, _, _ := r.takeWindow(l); again != nil {
		t.Fatal("a kept window is handed back only once")
	}
}

func TestWhatArrivesDuringTheWaitJoinsTheKeptWindow(t *testing.T) {
	r := quietRunner()
	l := &chatLink{ID: 3}
	r.foldIntoWindow(l, bridge.Message{ID: "x"}, false) // nothing kept: nothing to fold into
	if _, ok := r.windows[l.ID]; ok {
		t.Fatal("a window was made from a lone event")
	}
	r.keepWholeWindow(l, []bridge.Message{{ID: "m1", Text: "một", Version: 1}, {ID: "m2", Text: "hai", Version: 1}})
	r.foldIntoWindow(l, bridge.Message{ID: "m3", Text: "ba", Version: 1}, false)
	r.foldIntoWindow(l, bridge.Message{ID: "m1", Text: "một (sửa)", Version: 2}, true)
	r.foldIntoWindow(l, bridge.Message{ID: "m2", Text: "cũ", Version: 0}, true)          // older: ignored
	r.foldIntoWindow(l, bridge.Message{ID: "m0", Text: "ngoài", Version: 2}, true)       // edit of a message outside: left to the pages
	r.foldIntoWindow(l, bridge.Message{ID: "m3", Text: "ba lần nữa", Version: 1}, false) // a repeat
	got, _, complete := r.takeWindow(l)
	var texts []string
	for _, m := range got {
		texts = append(texts, m.Text)
	}
	if !complete || fmt.Sprint(texts) != "[ba hai một (sửa)]" {
		t.Fatalf("window = %v (complete %v), want [ba hai một (sửa)], newest first", texts, complete)
	}
}
