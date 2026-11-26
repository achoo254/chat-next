package telegram

import (
	"context"
	"strconv"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/tg"
)

// unreadMentionsLimit is the most messages UnreadMentions reads.
const unreadMentionsLimit = 100

// UnreadMentions implements bridge.MentionReader with messages.getUnreadMentions.
func (a *Adapter) UnreadMentions(ctx context.Context, acct bridge.Account, conv string) ([]string, error) {
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return nil, err
	}
	defer release()
	peer, err := c.inputPeer(ctx, conv)
	if err != nil {
		return nil, err
	}
	res, err := c.live.api().MessagesGetUnreadMentions(ctx, &tg.MessagesGetUnreadMentionsRequest{Peer: peer, Limit: unreadMentionsLimit})
	if err != nil {
		return nil, translate(err)
	}
	msgs, ok := res.AsModified()
	if !ok {
		return nil, nil
	}
	var ids []string
	for _, m := range msgs.GetMessages() {
		if _, empty := m.(*tg.MessageEmpty); !empty {
			ids = append(ids, strconv.Itoa(m.GetID()))
		}
	}
	return ids, nil
}

// ReadMentions implements bridge.MentionReader: the owner saw the messages, so their
// contents (the mention) are read, as a Telegram client marks them when shown.
func (a *Adapter) ReadMentions(ctx context.Context, acct bridge.Account, conv string, ids []string) error {
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return err
	}
	defer release()
	peer, err := c.inputPeer(ctx, conv)
	if err != nil {
		return err
	}
	nums := make([]int, 0, len(ids))
	for _, id := range ids {
		if n, err := strconv.Atoi(id); err == nil {
			nums = append(nums, n)
		}
	}
	if len(nums) == 0 {
		return nil
	}
	if ch, ok := peer.(*tg.InputPeerChannel); ok {
		_, err = c.live.api().ChannelsReadMessageContents(ctx, &tg.ChannelsReadMessageContentsRequest{
			Channel: &tg.InputChannel{ChannelID: ch.ChannelID, AccessHash: ch.AccessHash}, ID: nums})
	} else {
		_, err = c.live.api().MessagesReadMessageContents(ctx, nums)
	}
	return translate(err)
}
