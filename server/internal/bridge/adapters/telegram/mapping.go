package telegram

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/tg"
)

// Ids the core never looks inside: a conversation is "user:<id>",
// "chat:<id>" (a basic group) or "channel:<id>" (a supergroup or channel);
// a person is their user id, a channel posting as itself "channel:<id>".
const (
	prefixUser    = "user:"
	prefixChat    = "chat:"
	prefixChannel = "channel:"
)

// peerBook is what a message needs to be understood: the users, basic groups
// and channels Telegram sent along with it.
type peerBook struct {
	users    map[int64]*tg.User
	chats    map[int64]*tg.Chat
	channels map[int64]*tg.Channel
}

func newPeerBook() *peerBook {
	return &peerBook{users: map[int64]*tg.User{}, chats: map[int64]*tg.Chat{}, channels: map[int64]*tg.Channel{}}
}

// fromEntities wraps the entities of an update.
func fromEntities(e tg.Entities) *peerBook {
	b := newPeerBook()
	for id, u := range e.Users {
		b.users[id] = u
	}
	for id, c := range e.Chats {
		b.chats[id] = c
	}
	for id, c := range e.Channels {
		b.channels[id] = c
	}
	return b
}

// add records the users and chats of an API answer.
func (b *peerBook) add(users []tg.UserClass, chats []tg.ChatClass) {
	for _, u := range users {
		if user, ok := u.(*tg.User); ok {
			b.users[user.ID] = user
		}
	}
	for _, c := range chats {
		switch v := c.(type) {
		case *tg.Chat:
			b.chats[v.ID] = v
		case *tg.Channel:
			b.channels[v.ID] = v
		}
	}
}

// convID is the conversation a peer is.
func convID(p tg.PeerClass) string {
	switch v := p.(type) {
	case *tg.PeerUser:
		return prefixUser + strconv.FormatInt(v.UserID, 10)
	case *tg.PeerChat:
		return prefixChat + strconv.FormatInt(v.ChatID, 10)
	case *tg.PeerChannel:
		return prefixChannel + strconv.FormatInt(v.ChannelID, 10)
	}
	return ""
}

// userName is how a Telegram user is shown: first and last name, else the
// username, else a placeholder.
func userName(u *tg.User) string {
	name := strings.TrimSpace(u.FirstName + " " + u.LastName)
	if name == "" {
		name = u.Username
	}
	if name == "" {
		name = "Telegram " + strconv.FormatInt(u.ID, 10)
	}
	return name
}

// participantUser is a Telegram user as a bridge participant.
func participantUser(u *tg.User, self int64) bridge.Participant {
	named := strings.TrimSpace(u.FirstName+" "+u.LastName) != "" || u.Username != ""
	p := bridge.Participant{ID: strconv.FormatInt(u.ID, 10), Name: userName(u), Username: u.Username, IsBot: u.Bot, IsSelf: u.ID == self, NameUnknown: !named}
	withUserPhoto(&p, u)
	withUserPhone(&p, u)
	return p
}

// participantOf finds who a peer is. A user Telegram did not send along is
// still a person (named by their id, flagged NameUnknown: updates in short
// form carry no users); a channel stands for itself.
func (b *peerBook) participantOf(p tg.PeerClass, self int64) bridge.Participant {
	switch v := p.(type) {
	case *tg.PeerUser:
		if u := b.users[v.UserID]; u != nil {
			return participantUser(u, self)
		}
		return bridge.Participant{ID: strconv.FormatInt(v.UserID, 10), Name: "Telegram " + strconv.FormatInt(v.UserID, 10), IsSelf: v.UserID == self, NameUnknown: true}
	case *tg.PeerChannel:
		id := prefixChannel + strconv.FormatInt(v.ChannelID, 10)
		if c := b.channels[v.ChannelID]; c != nil {
			return bridge.Participant{ID: id, Name: c.Title, Username: c.Username}
		}
		return bridge.Participant{ID: id, Name: "Telegram channel", NameUnknown: true}
	case *tg.PeerChat:
		id := prefixChat + strconv.FormatInt(v.ChatID, 10)
		if c := b.chats[v.ChatID]; c != nil {
			return bridge.Participant{ID: id, Name: c.Title}
		}
	}
	return bridge.Participant{ID: "unknown", Name: "?"}
}

// sender is who sent a message: the sender Telegram names, otherwise the
// person on the other side of a private chat (or the owner for their own
// messages), otherwise the channel the post is in.
func (b *peerBook) sender(m *tg.Message, self int64) bridge.Participant {
	if from, ok := m.GetFromID(); ok {
		return b.participantOf(from, self)
	}
	if peer, ok := m.PeerID.(*tg.PeerUser); ok {
		if m.Out {
			return bridge.Participant{ID: strconv.FormatInt(self, 10), IsSelf: true, Name: "me"}
		}
		return b.participantOf(peer, self)
	}
	return b.participantOf(m.PeerID, self)
}

// entityKinds maps Telegram's entity types to the kinds of bridge.Entity.
// What is not listed (commands, phone numbers, custom emoji, quotes) has no
// counterpart and is dropped by the engine.
func mapEntities(ents []tg.MessageEntityClass) []bridge.Entity {
	out := make([]bridge.Entity, 0, len(ents))
	for _, e := range ents {
		base := bridge.Entity{Offset: e.GetOffset(), Length: e.GetLength()}
		switch v := e.(type) {
		case *tg.MessageEntityBold:
			base.Kind = "bold"
		case *tg.MessageEntityItalic:
			base.Kind = "italic"
		case *tg.MessageEntityUnderline:
			base.Kind = "underline"
		case *tg.MessageEntityStrike:
			base.Kind = "strike"
		case *tg.MessageEntitySpoiler:
			base.Kind = "spoiler"
		case *tg.MessageEntityCode:
			base.Kind = "code"
		case *tg.MessageEntityPre:
			base.Kind = "pre"
		case *tg.MessageEntityTextURL:
			base.Kind, base.URL = "link", v.URL
		case *tg.MessageEntityURL:
			base.Kind = "url"
		case *tg.MessageEntityEmail:
			base.Kind = "email"
		case *tg.MessageEntityHashtag:
			base.Kind = "hashtag"
		case *tg.MessageEntityMentionName:
			base.Kind, base.Mention = "mention", strconv.FormatInt(v.UserID, 10)
		default:
			continue
		}
		out = append(out, base)
	}
	return out
}

// mapButtons keeps the link buttons of an inline keyboard. Buttons that act
// on the bot (callbacks, games, payments) have no counterpart in Chat and
// are dropped, and so is a row left empty.
func mapButtons(m tg.ReplyMarkupClass) [][]bridge.Button {
	inline, ok := m.(*tg.ReplyInlineMarkup)
	if !ok {
		return nil
	}
	var rows [][]bridge.Button
	for _, r := range inline.Rows {
		var row []bridge.Button
		for _, b := range r.Buttons {
			if u, ok := b.Type.(*tg.InlineButtonTypeURL); ok && b.Text != "" && u.URL != "" {
				row = append(row, bridge.Button{Text: b.Text, URL: u.URL})
			}
		}
		if len(row) > 0 {
			rows = append(rows, row)
		}
	}
	return rows
}

// mapMedia lists what a message carries besides text. It describes; the
// bytes are fetched on demand (FetchMedia), by the message they belong to.
func mapMedia(m tg.MessageMediaClass) []bridge.Media {
	switch v := m.(type) {
	case nil, *tg.MessageMediaEmpty, *tg.MessageMediaWebPage, *tg.MessageMediaUnsupported:
		return nil
	case *tg.MessageMediaPhoto:
		return []bridge.Media{{Kind: "photo", MimeType: "image/jpeg"}}
	case *tg.MessageMediaDocument:
		doc, ok := v.Document.(*tg.Document)
		if !ok {
			return []bridge.Media{{Kind: "document"}}
		}
		return []bridge.Media{documentMedia(doc)}
	case *tg.MessageMediaGeo, *tg.MessageMediaGeoLive, *tg.MessageMediaVenue:
		return []bridge.Media{{Kind: "location"}}
	case *tg.MessageMediaContact:
		return []bridge.Media{{Kind: "contact"}}
	case *tg.MessageMediaPoll:
		return []bridge.Media{{Kind: "poll"}}
	default:
		return []bridge.Media{{Kind: "other"}}
	}
}

// documentMedia classifies a document by its attributes.
func documentMedia(d *tg.Document) bridge.Media {
	m := bridge.Media{Kind: "document", MimeType: d.MimeType, Size: d.Size}
	for _, a := range d.Attributes {
		switch v := a.(type) {
		case *tg.DocumentAttributeFilename:
			m.Name = v.FileName
		case *tg.DocumentAttributeVideo:
			m.Kind, m.Width, m.Height = "video", v.W, v.H
			m.Duration = time.Duration(v.Duration * float64(time.Second))
		case *tg.DocumentAttributeAudio:
			m.Kind = "audio"
			if v.Voice {
				m.Kind = "voice"
			}
			m.Duration = time.Duration(v.Duration) * time.Second
		case *tg.DocumentAttributeSticker:
			m.Kind = "sticker"
		case *tg.DocumentAttributeAnimated:
			m.Kind = "gif"
		case *tg.DocumentAttributeImageSize:
			m.Width, m.Height = v.W, v.H
		}
	}
	return m
}

// mapMessage turns a Telegram message into a bridge message; ok is false
// for a message that is not content (a service message, an empty one).
func (b *peerBook) mapMessage(m tg.MessageClass, self int64) (bridge.Message, bool) {
	if s, ok := m.(*tg.MessageService); ok {
		return b.mapService(s, self)
	}
	msg, ok := m.(*tg.Message)
	if !ok {
		return bridge.Message{}, false
	}
	conv := convID(msg.PeerID)
	if conv == "" {
		return bridge.Message{}, false
	}
	out := bridge.Message{
		Conversation: conv,
		ID:           strconv.Itoa(msg.ID),
		From:         b.sender(msg, self),
		Date:         time.Unix(int64(msg.Date), 0),
		Text:         msg.Message,
		Entities:     mapEntities(msg.Entities),
		Media:        mapMedia(msg.Media),
		Buttons:      mapButtons(msg.ReplyMarkup),
		Version:      int64(msg.EditDate),
	}
	for i := range out.Media {
		out.Media[i].Ref = fmt.Sprintf("%s/%d", conv, msg.ID)
	}
	if h, ok := msg.GetReplyTo(); ok {
		if rh, ok := h.(*tg.MessageReplyHeader); ok && rh.ReplyToMsgID != 0 && rh.ReplyToPeerID == nil && !startsTopic(rh) {
			out.ReplyTo = strconv.Itoa(rh.ReplyToMsgID)
		}
	}
	if b.isForum(msg.PeerID) {
		out.Topic = topicOf(msg)
	}
	if h, ok := msg.GetFwdFrom(); ok {
		out.Forward = b.forwardInfo(h, self)
	}
	return out, true
}
