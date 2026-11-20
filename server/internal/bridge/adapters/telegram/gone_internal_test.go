package telegram

import (
	"testing"

	"github.com/gotd/td/tg"
)

func TestTelegramsAnswerAboutAGroupTellsWhetherTheAccountIsOutOfIt(t *testing.T) {
	cases := []struct {
		name  string
		chats []tg.ChatClass
		gone  bool
	}{
		{"a channel still joined", []tg.ChatClass{&tg.Channel{ID: 1}}, false},
		{"a channel left", []tg.ChatClass{&tg.Channel{ID: 1, Left: true}}, true},
		{"a channel deleted or the account removed", []tg.ChatClass{&tg.ChannelForbidden{ID: 1}}, true},
		{"a group still joined", []tg.ChatClass{&tg.Chat{ID: 2}}, false},
		{"a group left", []tg.ChatClass{&tg.Chat{ID: 2, Left: true}}, true},
		{"a group turned into a supergroup", []tg.ChatClass{&tg.Chat{ID: 2, Deactivated: true}}, true},
		{"a group the account was removed from", []tg.ChatClass{&tg.ChatForbidden{ID: 2}}, true},
		{"nothing answered is not taken for gone", nil, false},
	}
	for _, c := range cases {
		if got := goneFrom(c.chats); got != c.gone {
			t.Errorf("%s: gone %v, want %v", c.name, got, c.gone)
		}
	}
}
