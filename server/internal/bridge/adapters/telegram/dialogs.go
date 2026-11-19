package telegram

import (
	"context"
	"time"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/tg"
)

var (
	_ bridge.DialogReader = (*Adapter)(nil)
	_ bridge.DialogWriter = (*Adapter)(nil)
)

// muteForever is the mute_until Telegram uses for "until unmuted".
const muteForever = 2147483647

// notifyKind is which of Telegram's defaults a dialog without its own mute follows.
type notifyKind int

const (
	notifyUsers notifyKind = iota
	notifyGroups
	notifyChannels
)

// dialogState is how the owner has a dialog set up: muted (until when), pinned in
// the list, marked unread. A dialog that has no mute of its own follows the default
// of its kind (Settings › Notifications: private chats, groups, channels), given
// in defaults as a mute_until.
func dialogState(d *tg.Dialog, kind notifyKind, defaults map[notifyKind]int64) bridge.DialogState {
	st := bridge.DialogState{Pinned: d.Pinned, UnreadMark: d.UnreadMark}
	if until, ok := d.NotifySettings.GetMuteUntil(); ok {
		st.MuteUntil = int64(until)
	} else {
		st.MuteUntil = defaults[kind]
	}
	return st
}

// kindOf tells which default a peer follows; a supergroup is a group, a broadcast
// channel a channel.
func kindOf(p tg.PeerClass, chats []tg.ChatClass) notifyKind {
	switch v := p.(type) {
	case *tg.PeerChat:
		return notifyGroups
	case *tg.PeerChannel:
		for _, c := range chats {
			if ch, ok := c.(*tg.Channel); ok && ch.ID == v.ChannelID && ch.Broadcast {
				return notifyChannels
			}
		}
		return notifyGroups
	}
	return notifyUsers
}

// notifyDefaults reads the mute_until of each of Telegram's three defaults.
func notifyDefaults(ctx context.Context, api *tg.Client) (map[notifyKind]int64, error) {
	out := map[notifyKind]int64{}
	for kind, peer := range map[notifyKind]tg.InputNotifyPeerClass{
		notifyUsers: &tg.InputNotifyUsers{}, notifyGroups: &tg.InputNotifyChats{}, notifyChannels: &tg.InputNotifyBroadcasts{},
	} {
		s, err := api.AccountGetNotifySettings(ctx, peer)
		if err != nil {
			return nil, err
		}
		if until, ok := s.GetMuteUntil(); ok {
			out[kind] = int64(until)
		}
	}
	return out, nil
}

// DialogStates implements bridge.DialogReader with one call for the dialogs
// of a batch of conversations.
func (a *Adapter) DialogStates(ctx context.Context, acct bridge.Account, convs []string) (map[string]bridge.DialogState, error) {
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return nil, err
	}
	defer release()
	var peers []tg.InputDialogPeerClass
	for _, conv := range convs {
		peer, err := c.inputPeer(ctx, conv)
		if err != nil {
			continue // not in the dialog list any more
		}
		peers = append(peers, &tg.InputDialogPeer{Peer: peer})
	}
	out := map[string]bridge.DialogState{}
	if len(peers) == 0 {
		return out, nil
	}
	res, err := c.live.api().MessagesGetPeerDialogs(ctx, peers)
	if err != nil {
		return nil, translate(err)
	}
	defaults, err := notifyDefaults(ctx, c.live.api())
	if err != nil {
		return nil, translate(err)
	}
	for _, raw := range res.Dialogs {
		if d, ok := raw.(*tg.Dialog); ok {
			if conv := convID(d.Peer); conv != "" {
				out[conv] = dialogState(d, kindOf(d.Peer, res.Chats), defaults)
			}
		}
	}
	return out, nil
}

// inputNotify is the notify settings that set only when notifications come back.
func inputMute(until int64) tg.InputPeerNotifySettings {
	var s tg.InputPeerNotifySettings
	if until > time.Now().Unix() {
		s.SetMuteUntil(int(min(until, muteForever)))
	} else {
		s.SetMuteUntil(0)
	}
	return s
}

// SetMute implements bridge.DialogWriter.
func (a *Adapter) SetMute(ctx context.Context, acct bridge.Account, conv string, until int64) error {
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return err
	}
	defer release()
	peer, err := c.inputPeer(ctx, conv)
	if err != nil {
		return err
	}
	_, err = c.live.api().AccountUpdateNotifySettings(ctx, &tg.AccountUpdateNotifySettingsRequest{
		Peer: &tg.InputNotifyPeer{Peer: peer}, Settings: inputMute(until)})
	return translatePin(err)
}

// SetDialogPinned implements bridge.DialogWriter.
func (a *Adapter) SetDialogPinned(ctx context.Context, acct bridge.Account, conv string, pinned bool) error {
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return err
	}
	defer release()
	peer, err := c.inputPeer(ctx, conv)
	if err != nil {
		return err
	}
	_, err = c.live.api().MessagesToggleDialogPin(ctx, &tg.MessagesToggleDialogPinRequest{Peer: &tg.InputDialogPeer{Peer: peer}, Pinned: pinned})
	return translatePin(err)
}

// SetUnreadMark implements bridge.DialogWriter.
func (a *Adapter) SetUnreadMark(ctx context.Context, acct bridge.Account, conv string, unread bool) error {
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return err
	}
	defer release()
	peer, err := c.inputPeer(ctx, conv)
	if err != nil {
		return err
	}
	_, err = c.live.api().MessagesMarkDialogUnread(ctx, &tg.MessagesMarkDialogUnreadRequest{Peer: &tg.InputDialogPeer{Peer: peer}, Unread: unread})
	return translatePin(err)
}
