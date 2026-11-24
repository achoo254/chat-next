package engine

import (
	"errors"
	"time"

	"app.local/server/internal/bridge"
)

// maxInlineWait is the longest a call waits out the other app's "wait before asking
// again" inside the run's single loop. A longer wait is not slept: the work is deferred
// (see holdFlood), so live events and sends from Chat keep going.
var maxInlineWait = 10 * time.Second

// holdFlood notes that the other app asked to wait: the periodic reads and the history
// imports stay quiet until then, since asking during the wait only makes it longer.
func (r *runner) holdFlood(limit *bridge.RateLimitError, what string) {
	until := time.Now().Add(limit.RetryAfter)
	if until.After(r.floodUntil) {
		r.floodUntil = until
	}
	r.logger.Warn("the other app asked to wait; the work is deferred, live events go on",
		"what", what, "wait", limit.RetryAfter.String())
}

// floodHeld reports that a wait the other app asked for is still running.
func (r *runner) floodHeld() bool { return time.Now().Before(r.floodUntil) }

// skipBusy is skipRefused for a periodic read or import: a wait the other app asked for
// is held and the round skipped, not slept in the loop. Events and sends use skipRefused,
// where an error must still end the run so nothing is lost.
func (r *runner) skipBusy(err error, what, conv string) error {
	var limit *bridge.RateLimitError
	if errors.As(err, &limit) {
		r.holdFlood(limit, what)
		return nil
	}
	return r.skipRefused(err, what, conv)
}
