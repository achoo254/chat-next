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
	req := &tg.MessagesEditForumTopicRequest{Peer: peer, TopicID: id}
	if edit.Title != nil {
		req.SetTitle(*edit.Title)
	}
	if edit.Closed != nil {
		req.SetClosed(*edit.Closed)
	}
	_, err = c.live.api().MessagesEditForumTopic(ctx, req)
	return translatePin(err)
}
