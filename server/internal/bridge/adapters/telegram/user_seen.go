package telegram

import (
	"time"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/tg"
)

// withUserSeen fills when a person was last online from the status Telegram sent. A "min"
// user or a user without a status leaves it unknown. When the person hides the exact time
// Telegram says only "recently", "within a week" or "within a month"; those become a time
// in the middle of the band, which the server shows as the same band again.
func withUserSeen(p *bridge.Participant, u *tg.User, now time.Time) {
	if u.Min {
		return
	}
	status, ok := u.GetStatus()
	if !ok {
		return
	}
	var seen time.Time
	switch s := status.(type) {
	case *tg.UserStatusOnline:
		seen = now
	case *tg.UserStatusOffline:
		seen = time.Unix(int64(s.WasOnline), 0)
	case *tg.UserStatusRecently:
		seen = now.Add(-24 * time.Hour)
	case *tg.UserStatusLastWeek:
		seen = now.Add(-5 * 24 * time.Hour)
	case *tg.UserStatusLastMonth:
		seen = now.Add(-15 * 24 * time.Hour)
	default:
		return
	}
	p.SeenKnown, p.Seen = true, seen
}
