package zalo

import (
	"sync"
	"time"
)

// When Zalo's refusals of a stored session mean it has ended. A refusal is the
// sidecar's session_rejected; what Zalo really answers for an expired session
// has not been observed on a real account yet, and a Zalo fault can look the
// same, so one refusal or a quick burst of them never ends the session: they
// must keep coming for an hour. Calling a live session revoked makes the owner
// scan a QR code again; keeping a dead one costs one sidecar start per engine
// backoff (at most every 5 minutes).
const (
	// revokeMinRefusals is how many counted refusals end the session.
	revokeMinRefusals = 3
	// revokeMinGap is how far apart refusals must be to count separately;
	// refusals closer than that to the last counted one are not counted.
	revokeMinGap = 10 * time.Minute
	// revokeMinSpan is how long the counted refusals must span, first to last.
	revokeMinSpan = time.Hour
	// revokeForgetAfter starts the count over when its first refusal is older.
	revokeForgetAfter = 24 * time.Hour
)

type refusalStreak struct {
	first, last time.Time
	count       int
}

// refusalTracker keeps the streak of refusals of each account. Only a refusal
// adds to it and only a connected listener clears it: other failures (network,
// Zalo unavailable) leave it as it is.
type refusalTracker struct {
	mu      sync.Mutex
	now     func() time.Time
	streaks map[string]refusalStreak
}

func newRefusalTracker(now func() time.Time) *refusalTracker {
	return &refusalTracker{now: now, streaks: map[string]refusalStreak{}}
}

// refused records a refusal and reports whether the session now counts as
// ended (the streak is then cleared) and how many refusals count so far.
func (t *refusalTracker) refused(account string) (revoked bool, counted int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	s := t.streaks[account]
	switch {
	case s.count == 0 || now.Sub(s.first) > revokeForgetAfter:
		s = refusalStreak{first: now, last: now, count: 1}
	case now.Sub(s.last) >= revokeMinGap:
		s.last, s.count = now, s.count+1
	}
	if s.count >= revokeMinRefusals && s.last.Sub(s.first) >= revokeMinSpan {
		delete(t.streaks, account)
		return true, s.count
	}
	t.streaks[account] = s
	return false, s.count
}

// connected clears the streak: Zalo took the session.
func (t *refusalTracker) connected(account string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.streaks, account)
}
