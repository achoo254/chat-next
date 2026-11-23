package zalo

import (
	"crypto/sha256"
	"slices"
	"sync"
	"time"

	"app.local/server/internal/bridge"
)

// Bounds of what one account remembers about its sends. A RandomID the engine
// repeats later than maxSentAge, or after maxSendAttempts newer ones, is no
// longer recognised by this process.
const (
	maxSendAttempts = 512
	maxOwnHeard     = 512
	maxSentAge      = 24 * time.Hour
	maxTextsPerTry  = 8
	maxProvenPeers  = 200
	zaloClockSlack  = time.Minute // Zalo's times against this machine's clock
)

// textHash stands for a text in memory: matching needs equality only.
type textHash [sha256.Size]byte

func hashText(s string) textHash { return sha256.Sum256([]byte(s)) }

// sendAttempt is what this process knows about one RandomID.
type sendAttempt struct {
	conv string
	// texts are every text tried under the RandomID: the engine reads the
	// message anew for each try, so an edit in Chat can change it.
	texts []textHash
	// lower and upper bound when Zalo's copy of an earlier try can be dated
	// (upper zero: no bound).
	lower, upper time.Time
	lastTry      time.Time // zero: never tried by this process
	created      time.Time
	ref          *bridge.SentRef // set once the message is known to exist
}

// ownMessage is a text message of the owner: heard live or read in a history page.
type ownMessage struct {
	conv string
	text textHash
	id   string
	date time.Time
}

// sentLog is, for one account, the RandomIDs this process tried or checked
// and the owner's own text messages it heard, so a repeated RandomID is
// answered with the message that already exists instead of a second one.
type sentLog struct {
	mu       sync.Mutex
	now      func() time.Time
	attempts map[int64]*sendAttempt
	order    []int64 // RandomIDs, oldest first
	own      []ownMessage
	ownAt    []time.Time      // when each of own was heard
	claimed  map[string]int64 // message id -> the RandomID it answers
}

func newSentLog(now func() time.Time) *sentLog {
	return &sentLog{now: now, attempts: map[int64]*sendAttempt{}, claimed: map[string]int64{}}
}

// lookup returns a copy of what is known about rid.
func (l *sentLog) lookup(rid int64) (sendAttempt, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.prune()
	a := l.attempts[rid]
	if a == nil {
		return sendAttempt{}, false
	}
	return *a, true
}

// open records rid with where an earlier try's message may lie, unless it is
// known already; either way text joins the texts tried.
func (l *sentLog) open(rid int64, conv string, text textHash, lower, upper time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.attemptFor(rid, conv, lower, upper).addText(text)
}

// tried records that rid is being sent now with text. From now on its
// message may be dated any time after the earliest try, so the upper bound
// of a RandomID checked against the previous process goes.
func (l *sentLog) tried(rid int64, conv string, text textHash) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	a := l.attemptFor(rid, conv, now.Add(-zaloClockSlack), time.Time{})
	a.addText(text)
	a.lastTry, a.upper = now, time.Time{}
}

// attemptFor returns the attempt of rid, creating it with the given bounds.
func (l *sentLog) attemptFor(rid int64, conv string, lower, upper time.Time) *sendAttempt {
	if a := l.attempts[rid]; a != nil {
		return a
	}
	l.prune()
	if len(l.order) >= maxSendAttempts {
		l.drop(l.order[0])
	}
	a := &sendAttempt{conv: conv, lower: lower, upper: upper, created: l.now()}
	l.attempts[rid] = a
	l.order = append(l.order, rid)
	return a
}

func (a *sendAttempt) addText(text textHash) {
	if !slices.Contains(a.texts, text) && len(a.texts) < maxTextsPerTry {
		a.texts = append(a.texts, text)
	}
}

// settle records the message rid created.
func (l *sentLog) settle(rid int64, ref bridge.SentRef) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if a := l.attempts[rid]; a != nil {
		a.ref = &ref
		for _, id := range ref.IDs {
			l.claimed[id] = rid
		}
	}
}

// forget drops rid: Zalo said no message was created.
func (l *sentLog) forget(rid int64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.drop(rid)
}

// heard keeps one of the owner's own text messages heard live.
func (l *sentLog) heard(m ownMessage) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.prune()
	if len(l.own) >= maxOwnHeard {
		l.own, l.ownAt = l.own[1:], l.ownAt[1:]
	}
	l.own = append(l.own, m)
	l.ownAt = append(l.ownAt, l.now())
}

// claimHeard looks for rid's message among the messages heard live.
func (l *sentLog) claimHeard(rid int64) (bridge.SentRef, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.claim(rid, l.own)
}

// claimAmong looks for rid's message among candidates (a history page).
func (l *sentLog) claimAmong(rid int64, candidates []ownMessage) (bridge.SentRef, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.claim(rid, candidates)
}

// claim takes the earliest candidate of rid's conversation with one of its
// texts, dated within its bounds and not the answer of another RandomID, as
// the message rid created.
func (l *sentLog) claim(rid int64, candidates []ownMessage) (bridge.SentRef, bool) {
	a := l.attempts[rid]
	if a == nil {
		return bridge.SentRef{}, false
	}
	var best *ownMessage
	for i := range candidates {
		c := &candidates[i]
		if c.conv != a.conv || !slices.Contains(a.texts, c.text) || c.date.Before(a.lower) || (!a.upper.IsZero() && c.date.After(a.upper)) {
			continue
		}
		if other, ok := l.claimed[c.id]; ok && other != rid {
			continue
		}
		if best == nil || c.date.Before(best.date) {
			best = c
		}
	}
	if best == nil {
		return bridge.SentRef{}, false
	}
	ref := bridge.SentRef{IDs: []string{best.id}, Date: best.date}
	a.ref = &ref
	l.claimed[best.id] = rid
	return ref, true
}

// drop removes rid and the claim of its message.
func (l *sentLog) drop(rid int64) {
	if a := l.attempts[rid]; a != nil && a.ref != nil {
		for _, id := range a.ref.IDs {
			if l.claimed[id] == rid {
				delete(l.claimed, id)
			}
		}
	}
	delete(l.attempts, rid)
	if i := slices.Index(l.order, rid); i >= 0 {
		l.order = slices.Delete(l.order, i, i+1)
	}
}

// prune drops what is older than maxSentAge.
func (l *sentLog) prune() {
	cutoff := l.now().Add(-maxSentAge)
	for len(l.order) > 0 && l.attempts[l.order[0]].created.Before(cutoff) {
		l.drop(l.order[0])
	}
	for len(l.ownAt) > 0 && l.ownAt[0].Before(cutoff) {
		l.own, l.ownAt = l.own[1:], l.ownAt[1:]
	}
}
