package engine

import (
	"context"
	"errors"
	"slices"
	"time"

	"app.local/server/internal/bridge"
)

// maxInlineWait is the longest a deferrable call (see deferLongWaits) waits out the other
// app's "wait before asking again" inside the run's single loop. A longer wait is not
// slept: the work is deferred (see holdFlood), so live events and sends keep going.
var maxInlineWait = 10 * time.Second

type deferKey struct{}

// deferLongWaits marks ctx for work the loop can put off and pick up later: the periodic
// reads and the history imports. A long wait there comes back as the RateLimitError
// instead of being slept.
func deferLongWaits(ctx context.Context) context.Context {
	return context.WithValue(ctx, deferKey{}, true)
}

// defersLongWaits reports whether ctx carries the mark of deferLongWaits.
func defersLongWaits(ctx context.Context) bool {
	v, _ := ctx.Value(deferKey{}).(bool)
	return v
}

// holdFlood notes that the other app asked to wait: the periodic reads and the history
// imports stay quiet until then, since asking during the wait only makes it longer.
func (r *runner) holdFlood(limit *bridge.RateLimitError, what string) {
	until := time.Now().Add(limit.RetryAfter)
	if until.After(r.floodUntil) {
		r.floodUntil = until
	}
	r.logger.Warn("the other app asked to wait; the work is deferred, live events go on",
		"what", what, "wait", limit.RetryAfter.String(), "until", until.Format(time.TimeOnly))
}

// isWait reports a wait the other app asked for that came back instead of being slept.
func isWait(err error) bool {
	var limit *bridge.RateLimitError
	return errors.As(err, &limit)
}

// floodHeld reports that a wait the other app asked for is still running.
func (r *runner) floodHeld() bool { return time.Now().Before(r.floodUntil) }

// skipBusy is skipRefused for a periodic read or import: a wait the other app asked for
// is held and the round skipped, not slept in the loop. Events and sends use skipRefused;
// their calls carry no deferLongWaits mark, so they still sleep a long wait out.
func (r *runner) skipBusy(err error, what, conv string) error {
	var limit *bridge.RateLimitError
	if errors.As(err, &limit) {
		r.holdFlood(limit, what)
		return nil
	}
	return r.skipRefused(err, what, conv)
}

// windowProgress is the part of a history window read before the other app asked to
// wait, newest first: the next read goes on from cur instead of asking for those pages
// again, which could otherwise hit the same limit at the same page on every try.
// complete is set when the whole window was read and an import of it was put off.
type windowProgress struct {
	newestFirst []bridge.Message
	cur         bridge.Cursor
	complete    bool
}

// keepWindow stores what fetchWindow read of chat l when it had to stop.
func (r *runner) keepWindow(l *chatLink, newestFirst []bridge.Message, cur bridge.Cursor) {
	r.storeWindow(l, windowProgress{newestFirst: newestFirst, cur: cur})
}

// keepWholeWindow stores a window read to the end (oldest first, as backfill holds it)
// whose import was put off by a wait.
func (r *runner) keepWholeWindow(l *chatLink, oldestFirst []bridge.Message) {
	newestFirst := slices.Clone(oldestFirst)
	slices.Reverse(newestFirst)
	r.storeWindow(l, windowProgress{newestFirst: newestFirst, complete: true})
}

func (r *runner) storeWindow(l *chatLink, w windowProgress) {
	if r.windows == nil {
		r.windows = map[int64]windowProgress{}
	}
	r.windows[l.ID] = w
}

// takeWindow hands back, once, what an earlier fetchWindow or backfill of chat l kept.
func (r *runner) takeWindow(l *chatLink) (newestFirst []bridge.Message, cur bridge.Cursor, complete bool) {
	w, ok := r.windows[l.ID]
	if !ok {
		return nil, bridge.Cursor{}, false
	}
	delete(r.windows, l.ID)
	return w.newestFirst, w.cur, w.complete
}

// foldIntoWindow puts a live message, or an edit, of a chat whose first import waits into
// the part of its history already read: events of a chat not imported yet are not applied
// and not replayed, so without this what arrives during the wait would be lost. A new
// message goes on top; an edit replaces its message when newer. An edit of a message not
// read yet is left to the pages still to read, which carry the edited version.
func (r *runner) foldIntoWindow(l *chatLink, m bridge.Message, isEdit bool) {
	w, ok := r.windows[l.ID]
	if !ok {
		return
	}
	for i, have := range w.newestFirst {
		if have.ID == m.ID {
			if m.Version > have.Version {
				w.newestFirst[i] = m
			}
			return
		}
	}
	if isEdit {
		return
	}
	w.newestFirst = append([]bridge.Message{m}, w.newestFirst...)
	r.windows[l.ID] = w
}
