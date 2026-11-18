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

var _ bridge.ReadWriter = (*Adapter)(nil)

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
