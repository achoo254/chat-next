package feature

import "testing"

func TestReactionAllowed(t *testing.T) {
	cases := []struct {
		app, emoji string
		want       bool
	}{
		{"telegram", "👍", true},
		{"telegram", "❤️", true}, // with the variation selector Chat's picker adds
		{"telegram", "❤", true},
		{"telegram", "❤‍🔥", true},
		{"telegram", "😱", true},
		{"telegram", "😮", false},
		{"zalo", "😮", true},
		{"zalo", "❤️", true},
		{"zalo", "🦄", false},
		{"other", "😮", true},
		{"", "😮", true},
	}
	for _, c := range cases {
		if got := ReactionAllowed(c.app, c.emoji); got != c.want {
			t.Errorf("ReactionAllowed(%q, %q) = %v, want %v", c.app, c.emoji, got, c.want)
		}
	}
}
