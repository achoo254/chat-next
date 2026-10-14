package ids

import (
	"errors"
	"fmt"
	"sync"
	"time"
)

// Snowflake ids are internal 63-bit storage keys for messages; they never
// leave the server (messages are exposed as (chat_id, seq)).
//
//	63 bits = [ms since SnowflakeEpoch: 41][worker: 10][sequence: 12]
const (
	snowflakeTimeBits     = 41
	snowflakeWorkerBits   = 10
	snowflakeSequenceBits = 12

	// MaxWorker is the largest Snowflake worker number.
	MaxWorker int64 = 1<<snowflakeWorkerBits - 1

	maxSnowflakeTime     int64 = 1<<snowflakeTimeBits - 1
	maxSnowflakeSequence int64 = 1<<snowflakeSequenceBits - 1

	// MaxClockRollback is how far the clock may read behind the last issued
	// millisecond before Next gives up. Smaller gaps are absorbed by waiting
	// until the clock passes that millisecond again, because failing writes is
	// worse than pausing id issue for under a second. The production clock is
	// monotonic (see NewSnowflake), so inside one process this only guards
	// replacement clocks; across restarts the worker lease is what keeps a
	// restarted worker after its previous ids.
	MaxClockRollback = time.Second

	sequenceExhaustedWait = 100 * time.Microsecond
)

// SnowflakeEpoch is the zero point of the Snowflake time field.
var SnowflakeEpoch = time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC)

var (
	// ErrClockMovedBackwards reports a clock reading more than
	// MaxClockRollback behind the last issued millisecond. Issuing ids then
	// would break ordering or uniqueness.
	ErrClockMovedBackwards = errors.New("ids: clock moved backwards")
	// ErrClockOutOfRange reports a clock before SnowflakeEpoch or beyond the
	// 41-bit time field (about 69 years after the epoch).
	ErrClockOutOfRange = errors.New("ids: clock outside the snowflake time range")
)

// Snowflake issues strictly increasing ids for one worker. It is safe for
// concurrent use.
type Snowflake struct {
	mu       sync.Mutex
	worker   int64
	lastMs   int64
	sequence int64

	// now returns milliseconds since the Unix epoch; sleep pauses the caller.
	// Both are replaceable in tests.
	now   func() int64
	sleep func(time.Duration)
}

// NewSnowflake returns a generator for worker in [0, MaxWorker]. Each running
// process must own a distinct, leased worker number (see the package comment).
//
// Time is read from the monotonic clock anchored at the wall clock of this
// call, so wall-clock steps after construction (NTP, manual changes) cannot
// reorder or repeat ids.
func NewSnowflake(worker int64) (*Snowflake, error) {
	if worker < 0 || worker > MaxWorker {
		return nil, fmt.Errorf("%w: worker %d not in [0, %d]", ErrOutOfRange, worker, MaxWorker)
	}
	return &Snowflake{
		worker: worker,
		lastMs: -1,
		now:    monotonicMillis(time.Now()),
		sleep:  time.Sleep,
	}, nil
}

// monotonicMillis returns a clock in milliseconds since the Unix epoch that
// starts at start's wall time and advances with start's monotonic reading.
func monotonicMillis(start time.Time) func() int64 {
	startMs := start.UnixMilli()
	return func() int64 { return startMs + time.Since(start).Milliseconds() }
}

// Next returns the next id. Ids from one generator are strictly increasing.
func (g *Snowflake) Next() (int64, error) {
	g.mu.Lock()
	defer g.mu.Unlock()

	for {
		nowMs, err := g.elapsed()
		if err != nil {
			return 0, err
		}
		switch {
		case nowMs > g.lastMs:
			g.lastMs = nowMs
			g.sequence = 0
			return g.compose(), nil
		case nowMs == g.lastMs && g.sequence < maxSnowflakeSequence:
			g.sequence++
			return g.compose(), nil
		case nowMs == g.lastMs:
			// The sequence of this millisecond is exhausted.
			g.sleep(sequenceExhaustedWait)
		default:
			behind := time.Duration(g.lastMs-nowMs) * time.Millisecond
			if behind > MaxClockRollback {
				return 0, fmt.Errorf("%w by %s", ErrClockMovedBackwards, behind)
			}
			g.sleep(behind)
		}
	}
}

func (g *Snowflake) compose() int64 {
	return g.lastMs<<(snowflakeWorkerBits+snowflakeSequenceBits) |
		g.worker<<snowflakeSequenceBits |
		g.sequence
}

// elapsed returns milliseconds since SnowflakeEpoch.
func (g *Snowflake) elapsed() (int64, error) {
	ms := g.now() - SnowflakeEpoch.UnixMilli()
	if ms < 0 || ms > maxSnowflakeTime {
		return 0, fmt.Errorf("%w: %d ms since epoch", ErrClockOutOfRange, ms)
	}
	return ms, nil
}
