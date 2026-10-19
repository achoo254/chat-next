// Package ratelimit is a token-bucket limiter keyed by caller and action.
//
// Stage 1 runs one api process, so the buckets live in process memory. When
// the api scales to several processes the same Limiter interface gets a
// shared (Redis) implementation; callers do not change.
package ratelimit

import (
	"sync"
	"time"
)

// Rule is one bucket shape: Burst tokens, refilled at Rate per second.
type Rule struct {
	Rate  float64
	Burst float64
}

// Limiter decides whether an action may run now.
type Limiter interface {
	// Allow takes one token of rule from the bucket of key.
	Allow(rule Rule, key string) bool
}

type bucket struct {
	tokens float64
	last   time.Time
}

// Memory is an in-process Limiter. Idle buckets are dropped by Sweep.
type Memory struct {
	mu      sync.Mutex
	buckets map[bucketKey]*bucket
	now     func() time.Time
}

type bucketKey struct {
	rule Rule
	key  string
}

// NewMemory returns an empty in-process limiter.
func NewMemory() *Memory {
	return &Memory{buckets: map[bucketKey]*bucket{}, now: time.Now}
}

// SetClock replaces the clock (tests that must not refill buckets while
// they run).
func (m *Memory) SetClock(now func() time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.now = now
}

// Allow implements Limiter.
func (m *Memory) Allow(rule Rule, key string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.now()
	k := bucketKey{rule, key}
	b, ok := m.buckets[k]
	if !ok {
		b = &bucket{tokens: rule.Burst, last: now}
		m.buckets[k] = b
	}
	b.tokens = min(rule.Burst, b.tokens+now.Sub(b.last).Seconds()*rule.Rate)
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// Sweep drops buckets that have been full for idle or longer; call it
// periodically to bound memory.
func (m *Memory) Sweep(idle time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.now()
	for k, b := range m.buckets {
		full := b.tokens+now.Sub(b.last).Seconds()*k.rule.Rate >= k.rule.Burst
		if full && now.Sub(b.last) >= idle {
			delete(m.buckets, k)
		}
	}
}

// Len returns the number of live buckets.
func (m *Memory) Len() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.buckets)
}
