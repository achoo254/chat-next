package engine

import (
	"context"
	"fmt"
	"time"

	"app.local/server/internal/bridge"
)

// seenStep is how much later a stated last-seen time must be than the recorded one to be
// written, so a message does not rewrite the row of a person every time.
const seenStep = 10 * time.Minute

// seenOf is the last-seen time to record for p: the time the app stated, never one in the
// future. ok is false when the app stated none.
func seenOf(p bridge.Participant, now time.Time) (time.Time, bool) {
	if !p.SeenKnown || p.Seen.IsZero() {
		return time.Time{}, false
	}
	if p.Seen.After(now) {
		return now, true
	}
	return p.Seen, true
}

// setSeen records when a person of the account was last online as the puppet's last-seen
// time. It only moves forward: an older time than the one recorded changes nothing.
func (d *db) setSeen(ctx context.Context, accountID int64, p bridge.Participant) error {
	at, ok := seenOf(p, time.Now())
	if !ok {
		return nil
	}
	if _, err := d.pool.Exec(ctx, `
		UPDATE users u SET last_seen_at = $3
		FROM external_users x
		WHERE x.account_id = $1 AND x.external_user_id = $2 AND x.user_id = u.id
		  AND (u.last_seen_at IS NULL OR u.last_seen_at < $4)`,
		accountID, p.ID, at, at.Add(-seenStep)); err != nil {
		return fmt.Errorf("bridge: record last seen: %w", err)
	}
	return nil
}
