package watch

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// ErrorCounter counts the error records a logger writes, per minute, so
// the watchdog sees errors pile up without reading log files.
type ErrorCounter struct {
	mu      sync.Mutex
	buckets map[int64]int // unix minute -> errors
	now     func() time.Time
}

// NewErrorCounter returns an empty counter.
func NewErrorCounter() *ErrorCounter {
	return &ErrorCounter{buckets: map[int64]int{}, now: time.Now}
}

func (c *ErrorCounter) add() {
	c.mu.Lock()
	defer c.mu.Unlock()
	minute := c.now().Unix() / 60
	c.buckets[minute]++
	// Keep an hour.
	for m := range c.buckets {
		if m < minute-60 {
			delete(c.buckets, m)
		}
	}
}

// Recent is the number of errors within window of now.
func (c *ErrorCounter) Recent(window time.Duration) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	from := c.now().Add(-window).Unix() / 60
	n := 0
	for m, count := range c.buckets {
		if m > from {
			n += count
		}
	}
	return n
}

// Handler wraps h so the counter sees its error records.
func (c *ErrorCounter) Handler(h slog.Handler) slog.Handler {
	return &countingHandler{next: h, counter: c}
}

type countingHandler struct {
	next    slog.Handler
	counter *ErrorCounter
}

func (h *countingHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.next.Enabled(ctx, level)
}

func (h *countingHandler) Handle(ctx context.Context, r slog.Record) error {
	if r.Level >= slog.LevelError {
		h.counter.add()
	}
	return h.next.Handle(ctx, r)
}

func (h *countingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &countingHandler{next: h.next.WithAttrs(attrs), counter: h.counter}
}

func (h *countingHandler) WithGroup(name string) slog.Handler {
	return &countingHandler{next: h.next.WithGroup(name), counter: h.counter}
}

// Process is the counter of this process's log (cmd/server wraps the
// logger with it; the api's watchdog reads it).
var Process = NewErrorCounter()
