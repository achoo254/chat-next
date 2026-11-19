package telegram

import (
	"testing"

	"github.com/gotd/td/tg"
)

func TestForwardInfoNamesThePersonOrOnlyTheName(t *testing.T) {
	b := newPeerBook()
	b.users[30] = &tg.User{ID: 30, FirstName: "Minh"}
	b.channels[40] = &tg.Channel{ID: 40, Title: "Kênh tin tức"}
	var person tg.MessageFwdHeader
	person.SetFromID(&tg.PeerUser{UserID: 30})
	if f := b.forwardInfo(person, 10); f.From == nil || f.From.ID != "30" || f.Name != "Minh" {
		t.Fatalf("from a person = %+v", f)
	}
	var channel tg.MessageFwdHeader
	channel.SetFromID(&tg.PeerChannel{ChannelID: 40})
	if f := b.forwardInfo(channel, 10); f.From != nil || f.Name != "Kênh tin tức" {
		t.Fatalf("from a channel = %+v", f)
	}
	var hidden tg.MessageFwdHeader
	hidden.SetFromName("Ẩn danh")
	if f := b.forwardInfo(hidden, 10); f.From != nil || f.Name != "Ẩn danh" {
		t.Fatalf("from a hidden author = %+v", f)
	}
}
