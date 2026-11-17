package telegram

import (
	"context"
	"strconv"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/tg"
)

// historyPageMax is the most messages Telegram returns for one request.
const historyPageMax = 100

// Backfill implements bridge.Adapter: one page of history older than the
// cursor, newest first. The engine collects the pages of the window and
// writes them oldest first.
func (a *Adapter) Backfill(ctx context.Context, acct bridge.Account, conv string, cur bridge.Cursor, limit int) (bridge.Page, error) {
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return bridge.Page{}, err
	}
	defer release()
	peer, err := c.inputPeer(ctx, conv)
	if err != nil {
		return bridge.Page{}, err
	}
	limit = max(1, min(limit, historyPageMax))
	req := &tg.MessagesGetHistoryRequest{Peer: peer, Limit: limit}
	if cur.Before != "" {
		if req.OffsetID, err = strconv.Atoi(cur.Before); err != nil {
			return bridge.Page{}, err
		}
	}
	res, err := c.live.api().MessagesGetHistory(ctx, req)
	if err != nil {
		return bridge.Page{}, translate(err)
	}
	var raw []tg.MessageClass
	book := newPeerBook()
	switch v := res.(type) {
	case *tg.MessagesMessages:
		raw = v.Messages
		book.add(v.Users, v.Chats)
	case *tg.MessagesMessagesSlice:
		raw = v.Messages
		book.add(v.Users, v.Chats)
	case *tg.MessagesChannelMessages:
		raw = v.Messages
		book.add(v.Users, v.Chats)
	}
	page := bridge.Page{Done: len(raw) < limit}
	oldest := 0
	for _, m := range raw {
		if id := m.GetID(); oldest == 0 || id < oldest {
			oldest = id
		}
		if msg, ok := book.mapMessage(m, c.live.self); ok {
			page.Messages = append(page.Messages, msg)
		}
	}
	if !page.Done && oldest != 0 {
		page.Next = bridge.Cursor{Before: strconv.Itoa(oldest)}
	} else {
		page.Done = true
	}
	return page, nil
}
