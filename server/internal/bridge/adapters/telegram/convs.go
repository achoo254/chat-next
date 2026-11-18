package telegram

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/telegram/query/dialogs"
	"github.com/gotd/td/tg"
)

// dialogsMax bounds how many dialogs one listing reads.
const dialogsMax = 1000

// ListConversations implements bridge.Adapter: the user's private chats,
// bots, groups, supergroups and channels. Secret chats are not in Telegram's
// dialog list (they cannot be read by another client), saved messages is the
// owner's own chat, and chats the account was removed from or that were
// upgraded are left out.
func (a *Adapter) ListConversations(ctx context.Context, acct bridge.Account) ([]bridge.Conversation, error) {
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return nil, err
	}
	defer release()
	return c.loadDialogs(ctx)
}

// loadDialogs reads the dialog list and remembers each conversation's
// addressable peer.
func (c *conn) loadDialogs(ctx context.Context) ([]bridge.Conversation, error) {
	var out []bridge.Conversation
	peers := map[string]tg.InputPeerClass{}
	hashes := map[int64]int64{}
	seen := 0
	err := dialogs.NewQueryBuilder(c.live.api()).GetDialogs().BatchSize(100).ForEach(ctx, func(_ context.Context, e dialogs.Elem) error {
		seen++
		if seen > dialogsMax {
			return errStopDialogs
		}
		dlg, ok := e.Dialog.(*tg.Dialog)
		if !ok {
			return nil
		}
		book := newPeerBook()
		for id, u := range e.Entities.Users() {
			book.users[id] = u
			hashes[id] = u.AccessHash
		}
		for id, ch := range e.Entities.Chats() {
			book.chats[id] = ch
		}
		for id, ch := range e.Entities.Channels() {
			book.channels[id] = ch
		}
		conv, ok := book.conversationOf(dlg.Peer, c.live.self)
		if !ok {
			return nil
		}
		peers[conv.ID] = e.Peer
		out = append(out, conv)
		return nil
	})
	if err != nil && err != errStopDialogs {
		return nil, translate(err)
	}
	c.mu.Lock()
	c.peers, c.convs, c.hashes = peers, out, hashes
	c.mu.Unlock()
	return out, nil
}

var errStopDialogs = fmt.Errorf("telegram: enough dialogs")

// conversationOf describes a dialog's peer as a conversation; ok is false
// for one that is not imported.
func (b *peerBook) conversationOf(p tg.PeerClass, self int64) (bridge.Conversation, bool) {
	id := convID(p)
	switch v := p.(type) {
	case *tg.PeerUser:
		u := b.users[v.UserID]
		if u == nil || u.Deleted || u.ID == self {
			return bridge.Conversation{}, false
		}
		peer := participantUser(u, self)
		kind := bridge.ConvPrivate
		if u.Bot {
			kind = bridge.ConvBot
		}
		return bridge.Conversation{ID: id, Kind: kind, Title: userName(u), Peer: &peer}, true
	case *tg.PeerChat:
		ch := b.chats[v.ChatID]
		if ch == nil || ch.Deactivated {
			return bridge.Conversation{}, false
		}
		return bridge.Conversation{ID: id, Kind: bridge.ConvGroup, Title: ch.Title}, true
	case *tg.PeerChannel:
		ch := b.channels[v.ChannelID]
		if ch == nil {
			return bridge.Conversation{}, false
		}
		kind := bridge.ConvGroup
		if ch.Broadcast {
			kind = bridge.ConvChannel
		}
		return bridge.Conversation{ID: id, Kind: kind, Title: ch.Title}, true
	}
	return bridge.Conversation{}, false
}

// inputPeer finds the peer to address a conversation by. A basic group
// needs no access hash; for a user or channel the dialog list is read once
// per connection.
func (c *conn) inputPeer(ctx context.Context, conv string) (tg.InputPeerClass, error) {
	c.mu.Lock()
	p := c.peers[conv]
	c.mu.Unlock()
	if p != nil {
		return p, nil
	}
	kind, raw, ok := strings.Cut(conv, ":")
	id, err := strconv.ParseInt(raw, 10, 64)
	if !ok || err != nil {
		return nil, fmt.Errorf("telegram: bad conversation id %q", conv)
	}
	if kind == "chat" {
		return &tg.InputPeerChat{ChatID: id}, nil
	}
	if _, err := c.loadDialogs(ctx); err != nil {
		return nil, err
	}
	c.mu.Lock()
	p = c.peers[conv]
	c.mu.Unlock()
	if p == nil {
		return nil, fmt.Errorf("telegram: conversation %s is not in the account's dialogs", conv)
	}
	return p, nil
}
