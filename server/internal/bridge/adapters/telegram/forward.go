package telegram

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/tg"
)

var _ bridge.Forwarder = (*Adapter)(nil)

// forwardInfo maps the forward header of a message.
func (b *peerBook) forwardInfo(h tg.MessageFwdHeader, self int64) *bridge.ForwardInfo {
	out := &bridge.ForwardInfo{Date: time.Unix(int64(h.Date), 0)}
	if name, ok := h.GetFromName(); ok {
		out.Name = name
	}
	if from, ok := h.GetFromID(); ok {
		p := b.participantOf(from, self)
		if _, isUser := from.(*tg.PeerUser); isUser {
			out.From = &p
		}
		if out.Name == "" {
			out.Name = p.Name
		}
	}
	return out
}

// ForwardMessages implements bridge.Forwarder with messages.forwardMessages.
func (a *Adapter) ForwardMessages(ctx context.Context, acct bridge.Account, fromConv string, ids []string, toConv, topic string, randomID int64) (bridge.SentRef, error) {
	nums := make([]int, len(ids))
	randoms := make([]int64, len(ids))
	for i, id := range ids {
		n, err := strconv.Atoi(id)
		if err != nil {
			return bridge.SentRef{}, fmt.Errorf("telegram: bad message id %q", id)
		}
		nums[i], randoms[i] = n, randomID+int64(i)
	}
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return bridge.SentRef{}, err
	}
	defer release()
	from, err := c.inputPeer(ctx, fromConv)
	if err != nil {
		return bridge.SentRef{}, err
	}
	to, err := c.inputPeer(ctx, toConv)
	if err != nil {
		return bridge.SentRef{}, err
	}
	req := &tg.MessagesForwardMessagesRequest{FromPeer: from, ID: nums, RandomID: randoms, ToPeer: to}
	if topic != "" && topic != generalTopic {
		top, err := strconv.Atoi(topic)
		if err != nil {
			return bridge.SentRef{}, fmt.Errorf("telegram: bad topic id %q", topic)
		}
		req.SetTopMsgID(top)
	}
	u, err := c.live.api().MessagesForwardMessages(ctx, req)
	if err != nil {
		return bridge.SentRef{}, translateSend(err)
	}
	return sentRef(u, randoms)
}
