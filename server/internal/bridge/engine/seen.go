package engine

import (
	"context"
	"fmt"
	"time"

	"app.local/server/internal/bridge"
)

// seenStep is how much later a stated last-seen time must be than the recorded one to be
// written, so a message does not rewrite the row of a person every time. A change of band
// or of being online is always written.
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

// setSeen records how a person of the account was last online on the puppet: the
// last-seen time (only moving forward), the band the app states it in, and until when the
// person is online.
func (d *db) setSeen(ctx context.Context, accountID int64, p bridge.Participant) error {
	at, ok := seenOf(p, time.Now())
	if !ok {
		return nil
	}
	var until *time.Time
	if !p.OnlineUntil.IsZero() {
		until = &p.OnlineUntil
	}
	if _, err := d.pool.Exec(ctx, `
		UPDATE external_users SET seen_band = $3, online_until = $4
		WHERE account_id = $1 AND external_user_id = $2
		  AND (seen_band <> $3 OR online_until IS DISTINCT FROM $4)`,
		accountID, p.ID, int16(p.SeenBand), until); err != nil {
		return fmt.Errorf("bridge: record presence: %w", err)
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

// onPresence records a status change of a person the account already has a puppet for.
func (r *runner) onPresence(ctx context.Context, p bridge.Participant) (bool, error) {
	if p.IsSelf || !p.SeenKnown {
		return false, nil
	}
	return false, r.e.db.setSeen(ctx, r.account.ID, p)
}
