package telegram

import (
	"context"
	"fmt"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/tg"
)

var (
	_ bridge.InfoReader = (*Adapter)(nil)
	_ bridge.InfoWriter = (*Adapter)(nil)
)

// groupInfo reads the title and description of a group or channel.
func (c *conn) groupInfo(ctx context.Context, peer tg.InputPeerClass) (bridge.GroupInfo, bool, error) {
	switch p := peer.(type) {
	case *tg.InputPeerChannel:
		full, err := c.live.api().ChannelsGetFullChannel(ctx, &tg.InputChannel{ChannelID: p.ChannelID, AccessHash: p.AccessHash})
		if err != nil {
			return bridge.GroupInfo{}, false, translate(err)
		}
		cf, ok := full.FullChat.(*tg.ChannelFull)
		if !ok {
			return bridge.GroupInfo{}, false, nil
		}
		info := bridge.GroupInfo{About: cf.About, PhotoID: photoID(cf.ChatPhoto)}
		for _, ch := range full.Chats {
			if cc, ok := ch.(*tg.Channel); ok && cc.ID == p.ChannelID {
				info.Title = cc.Title
			}
		}
		return info, true, nil
	case *tg.InputPeerChat:
		full, err := c.live.api().MessagesGetFullChat(ctx, p.ChatID)
		if err != nil {
			return bridge.GroupInfo{}, false, translate(err)
		}
		cf, ok := full.FullChat.(*tg.ChatFull)
		if !ok {
			return bridge.GroupInfo{}, false, nil
		}
		info := bridge.GroupInfo{About: cf.About}
		if p, ok := cf.GetChatPhoto(); ok {
			info.PhotoID = photoID(p)
		}
		for _, ch := range full.Chats {
			if cc, ok := ch.(*tg.Chat); ok && cc.ID == p.ChatID {
				info.Title = cc.Title
			}
		}
		return info, true, nil
	}
	return bridge.GroupInfo{}, false, nil // a person or a bot has no info of this kind
}

// GroupInfos implements bridge.InfoReader, one call per group.
func (a *Adapter) GroupInfos(ctx context.Context, acct bridge.Account, convs []string) (map[string]bridge.GroupInfo, error) {
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return nil, err
	}
	defer release()
	out := map[string]bridge.GroupInfo{}
	for _, conv := range convs {
		peer, err := c.inputPeer(ctx, conv)
		if err != nil {
			continue
		}
		info, ok, err := c.groupInfo(ctx, peer)
		if err != nil {
			return nil, err
		}
		if ok {
			if info.PhotoID != "" {
				info.PhotoRef = groupPhotoRef + conv
			}
			out[conv] = info
		}
	}
	return out, nil
}

// SetGroupInfo implements bridge.InfoWriter. It reads what the group has and
// changes only what differs: Telegram refuses to set what is already set, and the
// calls that would only be refused cost rate limit.
func (a *Adapter) SetGroupInfo(ctx context.Context, acct bridge.Account, conv string, want bridge.GroupInfo) error {
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return err
	}
	defer release()
	peer, err := c.inputPeer(ctx, conv)
	if err != nil {
		return err
	}
	have, ok, err := c.groupInfo(ctx, peer)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("%w: %s has no title or description to set", bridge.ErrNotAllowed, conv)
	}
	if want.Title != "" && want.Title != have.Title {
		var err error
		switch p := peer.(type) {
		case *tg.InputPeerChannel:
			_, err = c.live.api().ChannelsEditTitle(ctx, &tg.ChannelsEditTitleRequest{Channel: &tg.InputChannel{ChannelID: p.ChannelID, AccessHash: p.AccessHash}, Title: want.Title})
		case *tg.InputPeerChat:
			_, err = c.live.api().MessagesEditChatTitle(ctx, &tg.MessagesEditChatTitleRequest{ChatID: p.ChatID, Title: want.Title})
		}
		if err = translatePin(err); err != nil {
			return err
		}
	}
	if want.About != have.About {
		_, err := c.live.api().MessagesEditChatAbout(ctx, &tg.MessagesEditChatAboutRequest{Peer: peer, About: want.About})
		if err = translatePin(err); err != nil {
			return err
		}
	}
	return nil
}
