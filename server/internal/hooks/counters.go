package hooks

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

type bucketKey struct {
	hook string
	hour time.Time
}

type bucket struct {
	accepted, delivered, failed int64
}

type failureKey struct {
	bucketKey
	reason string
}

type failureCount struct {
	count int64
	last  time.Time
}

// counters accumulates per-hook counts in memory between flushes, so the
// request path never writes a counter row.
type counters struct {
	mu       sync.Mutex
	buckets  map[bucketKey]*bucket
	failures map[failureKey]*failureCount
	lastUsed map[string]time.Time
	// flushMu serializes flushes (the loop, stats reads, shutdown).
	flushMu sync.Mutex
}

func newCounters() *counters {
	return &counters{buckets: map[bucketKey]*bucket{}, failures: map[failureKey]*failureCount{}, lastUsed: map[string]time.Time{}}
}

func (c *counters) bucket(hook string, now time.Time) *bucket {
	k := bucketKey{hook, now.UTC().Truncate(time.Hour)}
	b := c.buckets[k]
	if b == nil {
		b = &bucket{}
		c.buckets[k] = b
	}
	return b
}

func (c *counters) accepted(hook string) {
	now := time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()
	c.bucket(hook, now).accepted++
	c.lastUsed[hook] = now
}

func (c *counters) delivered(hook string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.bucket(hook, time.Now()).delivered++
}

func (c *counters) failed(hook, reason string) {
	now := time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()
	c.bucket(hook, now).failed++
	k := failureKey{bucketKey{hook, now.UTC().Truncate(time.Hour)}, reason}
	f := c.failures[k]
	if f == nil {
		f = &failureCount{}
		c.failures[k] = f
	}
	f.count++
	f.last = now
}

// overlayLastUsed applies last-use times not flushed yet.
func (c *counters) overlayLastUsed(hooks []*hookRow) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, h := range hooks {
		if t, ok := c.lastUsed[h.ID]; ok && (h.LastUsedAt == nil || t.After(*h.LastUsedAt)) {
			h.LastUsedAt = &t
		}
	}
}

// take swaps out everything accumulated so far.
func (c *counters) take() (map[bucketKey]*bucket, map[failureKey]*failureCount, map[string]time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	b, f, u := c.buckets, c.failures, c.lastUsed
	c.buckets, c.failures, c.lastUsed = map[bucketKey]*bucket{}, map[failureKey]*failureCount{}, map[string]time.Time{}
	return b, f, u
}

// putBack merges counts whose write failed, so the next flush retries.
func (c *counters) putBack(buckets map[bucketKey]*bucket, failures map[failureKey]*failureCount, used map[string]time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for k, v := range buckets {
		b := c.buckets[k]
		if b == nil {
			b = &bucket{}
			c.buckets[k] = b
		}
		b.accepted += v.accepted
		b.delivered += v.delivered
		b.failed += v.failed
	}
	for k, v := range failures {
		f := c.failures[k]
		if f == nil {
			f = &failureCount{}
			c.failures[k] = f
		}
		f.count += v.count
		if v.last.After(f.last) {
			f.last = v.last
		}
	}
	for k, t := range used {
		if t.After(c.lastUsed[k]) {
			c.lastUsed[k] = t
		}
	}
}

// Flush adds the counts accumulated in memory to hook_counters and
// hook_failures, and the last-use times to incoming_hooks, in one
// transaction; on failure the counts stay for the next flush.
func (s *Service) Flush(ctx context.Context) error {
	s.counters.flushMu.Lock()
	defer s.counters.flushMu.Unlock()
	buckets, failures, used := s.counters.take()
	if len(buckets) == 0 && len(failures) == 0 && len(used) == 0 {
		return nil
	}
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		batch := &pgx.Batch{}
		for k, v := range buckets {
			batch.Queue(`
				INSERT INTO hook_counters (hook_id, hour, accepted, delivered_realtime, failed) VALUES ($1, $2, $3, $4, $5)
				ON CONFLICT (hook_id, hour) DO UPDATE SET accepted = hook_counters.accepted + excluded.accepted,
					delivered_realtime = hook_counters.delivered_realtime + excluded.delivered_realtime,
					failed = hook_counters.failed + excluded.failed`, k.hook, k.hour, v.accepted, v.delivered, v.failed)
		}
		for k, v := range failures {
			batch.Queue(`
				INSERT INTO hook_failures (hook_id, hour, reason, count, last_at) VALUES ($1, $2, $3, $4, $5)
				ON CONFLICT (hook_id, hour, reason) DO UPDATE SET count = hook_failures.count + excluded.count,
					last_at = greatest(hook_failures.last_at, excluded.last_at)`, k.hook, k.hour, k.reason, v.count, v.last)
		}
		for hook, at := range used {
			batch.Queue(`UPDATE incoming_hooks SET last_used_at = $2 WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < $2)`,
				hook, at)
		}
		return tx.SendBatch(ctx, batch).Close()
	})
	if err != nil {
		s.counters.putBack(buckets, failures, used)
		return fmt.Errorf("hooks: flush counters: %w", err)
	}
	return nil
}

// Run flushes the counters every few seconds and, every hour, drops what is
// past retention: idempotency keys after 24 hours; alert groups, counters
// and dead letters after 30 days. It returns when ctx ends (call Flush
// after the chat dispatcher drained, to keep the last counts).
func (s *Service) Run(ctx context.Context) {
	flush := time.NewTicker(flushEvery)
	defer flush.Stop()
	clean := time.NewTicker(maintenanceEvery)
	defer clean.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-flush.C:
			if err := s.Flush(ctx); err != nil && ctx.Err() == nil {
				s.logger.Warn("hook counters not flushed; retrying later", "err", err)
			}
		case <-clean.C:
			if err := s.cleanup(ctx); err != nil && ctx.Err() == nil {
				s.logger.Warn("hook cleanup failed", "err", err)
			}
		}
	}
}

func (s *Service) cleanup(ctx context.Context) error {
	now := time.Now()
	for _, q := range []struct {
		sql, what string
		before    time.Time
	}{
		{`DELETE FROM hook_idempotency WHERE created_at < $1`, "idempotency keys", now.Add(-idempotencyTTL)},
		{`DELETE FROM notify_groups WHERE updated_at < $1`, "alert groups", now.Add(-retention)},
		{`DELETE FROM hook_counters WHERE hour < $1`, "counters", now.Add(-retention)},
		{`DELETE FROM hook_failures WHERE hour < $1`, "failure counts", now.Add(-retention)},
		{`DELETE FROM hook_dead_letters WHERE created_at < $1`, "dead letters", now.Add(-retention)},
	} {
		if _, err := s.pool.Exec(ctx, q.sql, q.before); err != nil {
			return fmt.Errorf("hooks: drop old %s: %w", q.what, err)
		}
	}
	return nil
}
