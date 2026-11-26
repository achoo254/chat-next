package telegram

import (
	"context"
	"fmt"
	"strconv"

	"github.com/gotd/td/tg"

	"app.local/server/internal/bridge"
)

// MarkRead implements bridge.ReadWriter: tells Telegram the owner read the conversation up to
// the message. Telegram keeps the highest position, so marking what is read already is harmless.
func (a *Adapter) MarkRead(ctx context.Context, acct bridge.Account, conv, upToID string) error {
	id, err := strconv.Atoi(upToID)
	if err != nil {
		return fmt.Errorf("%w: message id %q", bridge.ErrNotAllowed, upToID)
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
	if p, ok := peer.(*tg.InputPeerChannel); ok {
		_, err = c.live.api().ChannelsReadHistory(ctx, &tg.ChannelsReadHistoryRequest{
			Channel: &tg.InputChannel{ChannelID: p.ChannelID, AccessHash: p.AccessHash}, MaxID: id})
		return translatePin(err)
	}
	_, err = c.live.api().MessagesReadHistory(ctx, &tg.MessagesReadHistoryRequest{Peer: peer, MaxID: id})
	return translatePin(err)
}

// MarkTopicRead implements bridge.TopicReadWriter: a topic of a forum is read with
// messages.readDiscussion on the message that opened it (1 for General). Should Telegram
// refuse that for a topic, the forum is read as a whole up to the message instead.
func (a *Adapter) MarkTopicRead(ctx context.Context, acct bridge.Account, conv, topic, upToID string) error {
	id, err := strconv.Atoi(upToID)
	if err != nil {
		return fmt.Errorf("%w: message id %q", bridge.ErrNotAllowed, upToID)
	}
	top, err := strconv.Atoi(topic)
	if err != nil {
		return fmt.Errorf("%w: topic %q", bridge.ErrNotAllowed, topic)
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
	_, err = c.live.api().MessagesReadDiscussion(ctx, &tg.MessagesReadDiscussionRequest{Peer: peer, MsgID: top, ReadMaxID: id})
	if err == nil {
		return nil
	}
	if p, ok := peer.(*tg.InputPeerChannel); ok && tg.IsMsgIDInvalid(err) {
		_, err = c.live.api().ChannelsReadHistory(ctx, &tg.ChannelsReadHistoryRequest{
			Channel: &tg.InputChannel{ChannelID: p.ChannelID, AccessHash: p.AccessHash}, MaxID: id})
	}
	return translatePin(err)
}

var (
	_ bridge.ReadWriter      = (*Adapter)(nil)
	_ bridge.TopicReadWriter = (*Adapter)(nil)
)

// registerSeen turns the owner's reading on another device into bridge.Seen events.
func registerSeen(d tg.UpdateDispatcher, emit func(context.Context, bridge.Event) error) {
	d.OnReadHistoryInbox(func(ctx context.Context, _ tg.Entities, u *tg.UpdateReadHistoryInbox) error {
		conv, ok := convOfPeer(u.Peer)
		if !ok {
			return nil
		}
		return emit(ctx, bridge.Event{Seen: &bridge.Seen{Conversation: conv, MaxID: strconv.Itoa(u.MaxID)}})
	})
	d.OnReadChannelInbox(func(ctx context.Context, _ tg.Entities, u *tg.UpdateReadChannelInbox) error {
		return emit(ctx, bridge.Event{Seen: &bridge.Seen{
			Conversation: prefixChannel + strconv.FormatInt(u.ChannelID, 10), MaxID: strconv.Itoa(u.MaxID)}})
	})
	// A topic of a forum read on another device.
	d.OnReadChannelDiscussionInbox(func(ctx context.Context, _ tg.Entities, u *tg.UpdateReadChannelDiscussionInbox) error {
		return emit(ctx, bridge.Event{Seen: &bridge.Seen{
			Conversation: prefixChannel + strconv.FormatInt(u.ChannelID, 10), MaxID: strconv.Itoa(u.ReadMaxID), Topic: strconv.Itoa(u.TopMsgID)}})
	})
}

func convOfPeer(p tg.PeerClass) (string, bool) {
	switch v := p.(type) {
	case *tg.PeerUser:
		return prefixUser + strconv.FormatInt(v.UserID, 10), true
	case *tg.PeerChat:
		return prefixChat + strconv.FormatInt(v.ChatID, 10), true
	}
	return "", false
}
