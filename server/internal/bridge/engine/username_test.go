package engine

import (
	"testing"

	"app.local/server/internal/bridge"
)

func TestStatedUsername(t *testing.T) {
	cases := map[string]string{
		"lan_nguyen":  "lan_nguyen",
		"@Lan.Nguyen": "lan_nguyen",
		"ab":          "",
		"":            "",
		"ext_77":      "",
		"tên":         "",
	}
	for in, want := range cases {
		if got := statedUsername(bridge.Participant{Username: in}); got != want {
			t.Errorf("%q: got %q, want %q", in, got, want)
		}
	}
}
