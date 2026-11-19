package telegram

import (
	"strconv"
	"time"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/tg"
)

// mapService turns a system line of Telegram into a message carrying a
// bridge.ServiceAction. Lines with no counterpart in Chat (games, payments, calls,
// the topic lines the engine learns as topic events) are not mapped.
func (b *peerBook) mapService(s *tg.MessageService, self int64) (bridge.Message, bool) {
	conv := convID(s.PeerID)
	if conv == "" {
		return bridge.Message{}, false
	}
	from := b.participantOf(s.PeerID, self)
	if f, ok := s.GetFromID(); ok {
		from = b.participantOf(f, self)
	} else if s.Out {
		from = bridge.Participant{ID: strconv.FormatInt(self, 10), IsSelf: true, Name: "me"}
	}
	people := func(ids ...int64) []bridge.Participant {
		out := make([]bridge.Participant, 0, len(ids))
		for _, id := range ids {
			out = append(out, b.participantOf(&tg.PeerUser{UserID: id}, self))
		}
		return out
	}
	var a bridge.ServiceAction
	switch v := s.Action.(type) {
	case *tg.MessageActionChatCreate:
		a = bridge.ServiceAction{Kind: bridge.ServiceChatCreated, Title: v.Title}
	case *tg.MessageActionChannelCreate:
		a = bridge.ServiceAction{Kind: bridge.ServiceChatCreated, Title: v.Title}
	case *tg.MessageActionChatAddUser:
		a = bridge.ServiceAction{Kind: bridge.ServiceMembersAdded, People: people(v.Users...)}
	case *tg.MessageActionChatJoinedByLink, *tg.MessageActionChatJoinedByRequest:
		a = bridge.ServiceAction{Kind: bridge.ServiceJoinedByLink}
	case *tg.MessageActionChatDeleteUser:
		if strconv.FormatInt(v.UserID, 10) == from.ID {
			a = bridge.ServiceAction{Kind: bridge.ServiceMemberLeft}
		} else {
			a = bridge.ServiceAction{Kind: bridge.ServiceMemberRemoved, People: people(v.UserID)}
		}
	case *tg.MessageActionChatEditTitle:
		a = bridge.ServiceAction{Kind: bridge.ServiceTitleChanged, Title: v.Title}
	case *tg.MessageActionChatEditPhoto:
		a = bridge.ServiceAction{Kind: bridge.ServicePhotoChanged}
	case *tg.MessageActionChatDeletePhoto:
		a = bridge.ServiceAction{Kind: bridge.ServicePhotoRemoved}
	case *tg.MessageActionPinMessage:
		rh, ok := s.ReplyTo.(*tg.MessageReplyHeader)
		if !ok {
			return bridge.Message{}, false
		}
		id, ok := rh.GetReplyToMsgID()
		if !ok {
			return bridge.Message{}, false
		}
		a = bridge.ServiceAction{Kind: bridge.ServiceMessagePinned, MessageID: strconv.Itoa(id)}
	default:
		return bridge.Message{}, false
	}
	out := bridge.Message{
		Conversation: conv,
		ID:           strconv.Itoa(s.ID),
		From:         from,
		Date:         time.Unix(int64(s.Date), 0),
		Service:      &a,
	}
	if b.isForum(s.PeerID) {
		out.Topic = serviceTopic(s)
	}
	return out, true
}

// serviceTopic is the topic a system line of a forum is in: the top id of its
// header when it has one (a pin inside a topic), else General. Unlike a message,
// the id a header without a top id names is the message the line is about.
func serviceTopic(s *tg.MessageService) string {
	if rh, ok := s.ReplyTo.(*tg.MessageReplyHeader); ok && rh.ForumTopic {
		if top, ok := rh.GetReplyToTopID(); ok {
			return strconv.Itoa(top)
		}
	}
	return generalTopic
}
