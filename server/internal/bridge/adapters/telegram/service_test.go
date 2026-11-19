package telegram

import (
	"testing"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/tg"
)

func TestMapServiceTurnsTelegramSystemLinesIntoActions(t *testing.T) {
	const self = 10
	b := newPeerBook()
	b.users[20] = &tg.User{ID: 20, FirstName: "Lan"}
	b.users[30] = &tg.User{ID: 30, FirstName: "Minh"}
	line := func(from int64, a tg.MessageActionClass) *tg.MessageService {
		s := &tg.MessageService{ID: 5, PeerID: &tg.PeerChat{ChatID: 3}, Date: 1700000000, Action: a}
		s.SetFromID(&tg.PeerUser{UserID: from})
		return s
	}
	pin := line(20, &tg.MessageActionPinMessage{})
	rh := &tg.MessageReplyHeader{}
	rh.SetReplyToMsgID(4)
	pin.SetReplyTo(rh)
	cases := []struct {
		name string
		in   *tg.MessageService
		kind bridge.ServiceKind
		ok   bool
	}{
		{"added", line(20, &tg.MessageActionChatAddUser{Users: []int64{30}}), bridge.ServiceMembersAdded, true},
		{"left", line(30, &tg.MessageActionChatDeleteUser{UserID: 30}), bridge.ServiceMemberLeft, true},
		{"removed", line(20, &tg.MessageActionChatDeleteUser{UserID: 30}), bridge.ServiceMemberRemoved, true},
		{"renamed", line(20, &tg.MessageActionChatEditTitle{Title: "Mới"}), bridge.ServiceTitleChanged, true},
		{"joined by link", line(30, &tg.MessageActionChatJoinedByLink{}), bridge.ServiceJoinedByLink, true},
		{"pinned", pin, bridge.ServiceMessagePinned, true},
		{"a call has no counterpart", line(20, &tg.MessageActionPhoneCall{}), "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m, ok := b.mapMessage(c.in, self)
			if ok != c.ok {
				t.Fatalf("mapped = %v, want %v", ok, c.ok)
			}
			if !ok {
				return
			}
			if m.Service == nil || m.Service.Kind != c.kind || m.Text != "" || m.Conversation != prefixChat+"3" || m.ID != "5" {
				t.Fatalf("got %+v (%+v)", m, m.Service)
			}
		})
	}
	m, _ := b.mapMessage(cases[0].in, self)
	if m.From.Name != "Lan" || len(m.Service.People) != 1 || m.Service.People[0].Name != "Minh" {
		t.Fatalf("added: from %+v, people %+v", m.From, m.Service.People)
	}
	m, _ = b.mapMessage(pin, self)
	if m.Service.MessageID != "4" {
		t.Fatalf("pinned names message %q, want 4", m.Service.MessageID)
	}
}
