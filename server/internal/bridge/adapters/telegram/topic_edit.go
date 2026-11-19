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
