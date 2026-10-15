package rpc

import (
	"testing"
	"time"
)

func TestIsNewLogin(t *testing.T) {
	now := time.Date(2026, 10, 15, 16, 40, 0, 0, time.UTC)
	cases := []struct {
		name    string
		created time.Time
		current bool
		want    bool
	}{
		{"signed in an hour ago", now.Add(-time.Hour), false, true},
		{"just under a day", now.Add(-newLoginWindow + time.Second), false, true},
		{"exactly a day", now.Add(-newLoginWindow), false, false},
		{"two days ago", now.Add(-48 * time.Hour), false, false},
		{"the session asking", now.Add(-time.Minute), true, false},
	}
	for _, c := range cases {
		if got := isNewLogin(c.created, now, c.current); got != c.want {
			t.Errorf("%s: isNewLogin = %v, want %v", c.name, got, c.want)
		}
	}
}
