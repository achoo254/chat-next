package telegram

import (
	"context"
	"strconv"
	"time"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/tg"
)

// withUserSeen fills when a person was last online from the status Telegram sent. A "min"
// user or a user without a status leaves it unknown. When the person hides the exact time
// Telegram says only "recently", "within a week" or "within a month"; those keep the band
// (SeenBand) with a time in the middle of it. A person online now is online until the
// status's expiry.
func withUserSeen(p *bridge.Participant, u *tg.User, now time.Time) {
	if u.Min {
		return
	}
	status, ok := u.GetStatus()
	if !ok {
		return
	}
	setSeen(p, status, now)
}

// setSeen fills p from a Telegram status; it reports false for a status it does not know.
func setSeen(p *bridge.Participant, status tg.UserStatusClass, now time.Time) bool {
	var seen time.Time
	band := bridge.SeenExact
	var until time.Time
	switch s := status.(type) {
	case *tg.UserStatusOnline:
		// Online until Expires; a status read after it lapsed means last seen then, not now.
		seen = now
		until = time.Unix(int64(s.Expires), 0)
		if !until.After(now) {
			seen, until = until, time.Time{}
		}
	case *tg.UserStatusOffline:
		seen = time.Unix(int64(s.WasOnline), 0)
	case *tg.UserStatusRecently:
		seen, band = now.Add(-24*time.Hour), bridge.SeenRecently
	case *tg.UserStatusLastWeek:
		seen, band = now.Add(-5*24*time.Hour), bridge.SeenLastWeek
	case *tg.UserStatusLastMonth:
		seen, band = now.Add(-15*24*time.Hour), bridge.SeenLastMonth
	default:
		return false
	}
	p.SeenKnown, p.Seen, p.SeenBand, p.OnlineUntil = true, seen, band, until
	return true
}

// registerUserStatus turns Telegram's status updates (someone came online or left) into
// Participant events.
func registerUserStatus(d tg.UpdateDispatcher, emit func(context.Context, bridge.Event) error) {
	d.OnUserStatus(func(ctx context.Context, _ tg.Entities, u *tg.UpdateUserStatus) error {
		p := bridge.Participant{ID: strconv.FormatInt(u.UserID, 10)}
		if !setSeen(&p, u.Status, time.Now()) {
			return nil
		}
		return emit(ctx, bridge.Event{Participant: &p})
	})
}
