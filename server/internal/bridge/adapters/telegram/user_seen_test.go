package telegram

import (
	"testing"
	"time"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/tg"
)

func TestWithUserSeen(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	user := func(s tg.UserStatusClass, min bool) *tg.User {
		u := &tg.User{Min: min}
		if s != nil {
			u.SetStatus(s)
		}
		return u
	}
	cases := []struct {
		name   string
		u      *tg.User
		known  bool
		within [2]time.Duration // seen is now+within[0] .. now+within[1]
	}{
		{"online is now", user(&tg.UserStatusOnline{}, false), true, [2]time.Duration{0, 0}},
		{"offline keeps the exact time", user(&tg.UserStatusOffline{WasOnline: int(now.Add(-2 * time.Hour).Unix())}, false), true, [2]time.Duration{-2 * time.Hour, -2 * time.Hour}},
		{"recently is within three days", user(&tg.UserStatusRecently{}, false), true, [2]time.Duration{-72 * time.Hour, 0}},
		{"last week is within a week", user(&tg.UserStatusLastWeek{}, false), true, [2]time.Duration{-7 * 24 * time.Hour, -3 * 24 * time.Hour}},
		{"last month is within a month", user(&tg.UserStatusLastMonth{}, false), true, [2]time.Duration{-30 * 24 * time.Hour, -7 * 24 * time.Hour}},
		{"no status stays unknown", user(nil, false), false, [2]time.Duration{}},
		{"a min user stays unknown", user(&tg.UserStatusOnline{}, true), false, [2]time.Duration{}},
	}
	for _, c := range cases {
		var p bridge.Participant
		withUserSeen(&p, c.u, now)
		if p.SeenKnown != c.known {
			t.Fatalf("%s: SeenKnown = %v", c.name, p.SeenKnown)
		}
		if !c.known {
			continue
		}
		if d := p.Seen.Sub(now); d < c.within[0] || d > c.within[1] {
			t.Errorf("%s: seen %v from now, want within %v", c.name, d, c.within)
		}
	}
}
