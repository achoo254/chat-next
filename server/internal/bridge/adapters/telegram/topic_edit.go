package telegram

import (
	"context"
	"fmt"
	"strconv"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/tg"
)

var _ bridge.TopicWriter = (*Adapter)(nil)

// EditTopic implements bridge.TopicWriter: rename, close and reopen a topic.
func (a *Adapter) EditTopic(ctx context.Context, acct bridge.Account, conv, topic string, edit bridge.TopicEdit) error {
	id, err := strconv.Atoi(topic)
	if err != nil {
		return fmt.Errorf("telegram: bad topic id %q", topic)
	}
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return err
	}
	defer release()
	peer, err := c.inputPeer(ctx, conv)
	if err != nil {
		return err
	}
	for _, req := range topicEditRequests(peer, id, edit) {
		if _, err := c.live.api().MessagesEditForumTopic(ctx, req); err != nil {
			if err := translatePin(err); err != nil {
				return err
			}
		}
	}
	return nil
}

// topicEditRequests splits an edit into the calls Telegram takes: the closed flag
// cannot go with any other field (TOPIC_CLOSE_SEPARATELY), so the title goes first
// and the closed state in a call of its own.
func topicEditRequests(peer tg.InputPeerClass, id int, edit bridge.TopicEdit) []*tg.MessagesEditForumTopicRequest {
	var out []*tg.MessagesEditForumTopicRequest
	if edit.Title != nil {
		req := &tg.MessagesEditForumTopicRequest{Peer: peer, TopicID: id}
		req.SetTitle(*edit.Title)
		out = append(out, req)
	}
	if edit.Closed != nil {
		req := &tg.MessagesEditForumTopicRequest{Peer: peer, TopicID: id}
		req.SetClosed(*edit.Closed)
		out = append(out, req)
	}
	return out
}

var _ bridge.TopicCreator = (*Adapter)(nil)

// CreateTopic implements bridge.TopicCreator. Telegram answers with the system line
// that opened the topic; its id is the topic's id.
func (a *Adapter) CreateTopic(ctx context.Context, acct bridge.Account, conv, title string, iconColor int, randomID int64) (string, error) {
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return "", err
	}
	defer release()
	peer, err := c.inputPeer(ctx, conv)
	if err != nil {
		return "", err
	}
	req := &tg.MessagesCreateForumTopicRequest{Peer: peer, Title: title, RandomID: randomID}
	if iconColor != 0 {
		req.SetIconColor(iconColor)
	}
	u, err := c.live.api().MessagesCreateForumTopic(ctx, req)
	if err != nil {
		return "", translatePin(err)
	}
	if id, ok := createdTopicID(u); ok {
		return id, nil
	}
	return "", fmt.Errorf("telegram: created topic not found in the answer")
}

// createdTopicID finds the id of the topic a create answer opened.
func createdTopicID(u tg.UpdatesClass) (string, bool) {
	var list []tg.UpdateClass
	switch v := u.(type) {
	case *tg.Updates:
		list = v.Updates
	case *tg.UpdatesCombined:
		list = v.Updates
	}
	for _, x := range list {
		var m tg.MessageClass
		switch v := x.(type) {
		case *tg.UpdateNewChannelMessage:
			m = v.Message
		case *tg.UpdateNewMessage:
			m = v.Message
		}
		if s, ok := m.(*tg.MessageService); ok {
			if _, ok := s.Action.(*tg.MessageActionTopicCreate); ok {
				return strconv.Itoa(s.ID), true
			}
		}
	}
	return "", false
}
