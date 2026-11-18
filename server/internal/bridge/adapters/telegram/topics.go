package telegram

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/tg"
)

var _ bridge.TopicReader = (*Adapter)(nil)

// generalTopic is the id Telegram gives the General topic of a forum.
const generalTopic = "1"

// topicPageMax is how many topics one request returns at most.
const topicPageMax = 100

// topicPagesMax bounds how many pages one listing reads (a forum has far
// fewer topics than that, and a listing must end).
const topicPagesMax = 20

// isForum reports whether the peer is a supergroup split into topics.
func (b *peerBook) isForum(p tg.PeerClass) bool {
	ch, ok := p.(*tg.PeerChannel)
	if !ok {
		return false
	}
	c := b.channels[ch.ChannelID]
	return c != nil && c.Forum && !c.Broadcast
}

// startsTopic reports whether a reply header only says which topic a message
// was posted in: such a message answers no one (its ReplyToMsgID is the id of
// the message that opened the topic).
func startsTopic(rh *tg.MessageReplyHeader) bool {
	_, hasTop := rh.GetReplyToTopID()
	return rh.ForumTopic && !hasTop
}

// topicOf is the topic of a message of a forum, by the rule checked against
// Telegram (spike of 2026-11-18): no reply header is General; a header with the
// forum flag and no top id is a message posted in the topic ReplyToMsgID; with a
// top id it is a reply inside the topic ReplyToTopID; a header without the flag
// is General.
func topicOf(m *tg.Message) string {
	rh, ok := m.ReplyTo.(*tg.MessageReplyHeader)
	if !ok || !rh.ForumTopic {
		return generalTopic
	}
	if top, ok := rh.GetReplyToTopID(); ok {
		return strconv.Itoa(top)
	}
	if id, ok := rh.GetReplyToMsgID(); ok {
		return strconv.Itoa(id)
	}
	return generalTopic
}

// forumTopic maps a topic of Telegram.
func forumTopic(t *tg.ForumTopic) bridge.Topic {
	return bridge.Topic{
		ID: strconv.Itoa(t.ID), Title: t.Title, IconColor: t.IconColor, Closed: t.Closed, Pinned: t.Pinned, Hidden: t.Hidden,
		General: t.ID == 1, Created: time.Unix(int64(t.Date), 0),
	}
}

// listForumTopics reads every topic of a forum, page by page. Telegram's own
// count is not used (it does not match the entries, which include General and
// topics already deleted): a listing ends on a short page.
func listForumTopics(ctx context.Context, fetch func(*tg.MessagesGetForumTopicsRequest) (*tg.MessagesForumTopics, error), peer tg.InputPeerClass) ([]bridge.Topic, error) {
	req := &tg.MessagesGetForumTopicsRequest{Peer: peer, Limit: topicPageMax}
	var out []bridge.Topic
	seen := map[int]bool{}
	for page := 0; page < topicPagesMax; page++ {
		res, err := fetch(req)
		if err != nil {
			return nil, err
		}
		var last *tg.ForumTopic
		for _, c := range res.Topics {
			t, ok := c.(*tg.ForumTopic)
			if !ok {
				continue // a topic that was deleted
			}
			last = t
			if !seen[t.ID] {
				seen[t.ID] = true
				out = append(out, forumTopic(t))
			}
		}
		if len(res.Topics) < topicPageMax || last == nil {
			return out, nil
		}
		req.OffsetTopic, req.OffsetID, req.OffsetDate = last.ID, last.TopMessage, messageDate(res.Messages, last.TopMessage)
		if err := ctx.Err(); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// messageDate finds the date of message id among messages (the offset of the
// next page of topics is the date of the top message of the last one).
func messageDate(msgs []tg.MessageClass, id int) int {
	for _, m := range msgs {
		switch v := m.(type) {
		case *tg.Message:
			if v.ID == id {
				return v.Date
			}
		case *tg.MessageService:
			if v.ID == id {
				return v.Date
			}
		}
	}
	return 0
}

// ListTopics implements bridge.TopicReader.
func (a *Adapter) ListTopics(ctx context.Context, acct bridge.Account, conv string) ([]bridge.Topic, error) {
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return nil, err
	}
	defer release()
	peer, err := c.inputPeer(ctx, conv)
	if err != nil {
		return nil, err
	}
	if _, ok := peer.(*tg.InputPeerChannel); !ok {
		return nil, fmt.Errorf("telegram: %s has no topics", conv)
	}
	list, err := listForumTopics(ctx, func(req *tg.MessagesGetForumTopicsRequest) (*tg.MessagesForumTopics, error) {
		return c.live.api().MessagesGetForumTopics(ctx, req)
	}, peer)
	return list, translate(err)
}

// topicAction reads a service message that opens or changes a topic: the
// conversation, the id of the topic and whether it is new. For a new topic the
// id is the id of the service message itself; for a change it is in the reply
// header.
func (b *peerBook) topicAction(m tg.MessageClass) (conv, topic string, created bool, ok bool) {
	s, isService := m.(*tg.MessageService)
	if !isService || !b.isForum(s.PeerID) {
		return "", "", false, false
	}
	conv = convID(s.PeerID)
	switch s.Action.(type) {
	case *tg.MessageActionTopicCreate:
		return conv, strconv.Itoa(s.ID), true, true
	case *tg.MessageActionTopicEdit:
		rh, hasHeader := s.ReplyTo.(*tg.MessageReplyHeader)
		if !hasHeader {
			return "", "", false, false
		}
		if top, ok := rh.GetReplyToTopID(); ok {
			return conv, strconv.Itoa(top), false, true
		}
		if id, ok := rh.GetReplyToMsgID(); ok {
			return conv, strconv.Itoa(id), false, true
		}
	}
	return "", "", false, false
}

// topicNow asks Telegram what a topic is now (name, colour, closed, pinned,
// hidden), so a change reported by a service message that names only what
// changed still gives the engine the whole topic.
func (c *conn) topicNow(ctx context.Context, conv, topic string) (bridge.Topic, error) {
	id, err := strconv.Atoi(topic)
	if err != nil {
		return bridge.Topic{}, fmt.Errorf("telegram: bad topic id %q", topic)
	}
	peer, err := c.inputPeer(ctx, conv)
	if err != nil {
		return bridge.Topic{}, err
	}
	res, err := c.live.api().MessagesGetForumTopicsByID(ctx, &tg.MessagesGetForumTopicsByIDRequest{Peer: peer, Topics: []int{id}})
	if err != nil {
		return bridge.Topic{}, translate(err)
	}
	for _, t := range res.Topics {
		if ft, ok := t.(*tg.ForumTopic); ok && ft.ID == id {
			return forumTopic(ft), nil
		}
	}
	return bridge.Topic{}, fmt.Errorf("telegram: topic %s of %s is not there any more", topic, conv)
}

// topicReplyTo is the reply header that puts a message in a topic: a message
// posted in a topic answers the topic's first message; a reply inside a topic
// names the message answered and the topic. General takes no topic header.
func topicReplyTo(reply, topic string) (tg.InputReplyToClass, error) {
	replyID, topicID := 0, 0
	var err error
	if reply != "" {
		if replyID, err = strconv.Atoi(reply); err != nil {
			return nil, fmt.Errorf("telegram: bad reply id %q", reply)
		}
	}
	if topic != "" && topic != generalTopic {
		if topicID, err = strconv.Atoi(topic); err != nil {
			return nil, fmt.Errorf("telegram: bad topic id %q", topic)
		}
	}
	switch {
	case replyID == 0 && topicID == 0:
		return nil, nil
	case topicID == 0:
		return &tg.InputReplyToMessage{ReplyToMsgID: replyID}, nil
	case replyID == 0:
		return &tg.InputReplyToMessage{ReplyToMsgID: topicID}, nil
	}
	return &tg.InputReplyToMessage{ReplyToMsgID: replyID, TopMsgID: topicID}, nil
}
