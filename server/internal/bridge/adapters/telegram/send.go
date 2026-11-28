package telegram

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"
	"unicode/utf16"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
)

// Telegram's limits on what one message carries, in UTF-16 code units.
const (
	textMax    = 4096
	captionMax = 1024
)

var _ bridge.Sender = (*Adapter)(nil)

// SendMessage implements bridge.Sender: a text message, or the file(s) of
// OutMessage.Media with Text as the caption of the first. The same RandomID
// gives the same message (Telegram answers a repeat with the one it took,
// checked on 2026-11-18); an album derives item i's id as RandomID+i.
func (a *Adapter) SendMessage(ctx context.Context, acct bridge.Account, m bridge.OutMessage) (bridge.SentRef, error) {
	limit := textMax
	if len(m.Media) > 0 {
		limit = captionMax
	}
	if len(utf16.Encode([]rune(m.Text))) > limit {
		return bridge.SentRef{}, fmt.Errorf("%w: the text is over %d characters", bridge.ErrTooLarge, limit)
	}
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return bridge.SentRef{}, err
	}
	defer release()
	peer, err := c.inputPeer(ctx, m.Conversation)
	if err != nil {
		return bridge.SentRef{}, err
	}
	ents := c.outEntities(m.Entities)
	reply, err := topicReplyTo(m.ReplyTo, m.Topic)
	if err != nil {
		return bridge.SentRef{}, err
	}
	send := func(reply tg.InputReplyToClass) (tg.UpdatesClass, []int64, error) {
		if m.Poll != nil {
			u, err := c.sendPoll(ctx, peer, m, reply)
			if err != nil {
				return nil, nil, translatePoll(err)
			}
			return u, []int64{m.RandomID}, nil
		}
		if len(m.Media) > 0 {
			return c.sendFiles(ctx, peer, m, ents, reply)
		}
		u, err := c.live.api().MessagesSendMessage(ctx, &tg.MessagesSendMessageRequest{
			Peer: peer, Message: m.Text, Entities: ents, RandomID: m.RandomID, ReplyTo: reply})
		return u, []int64{m.RandomID}, err
	}
	u, randoms, err := send(reply)
	if tgerr.Is(err, "REPLY_MESSAGE_ID_INVALID", "MESSAGE_ID_INVALID") && m.ReplyTo != "" {
		// The message answered is gone over there: the answer is sent as a
		// plain message (still in its topic) rather than not at all.
		plain, perr := topicReplyTo("", m.Topic)
		if perr != nil {
			return bridge.SentRef{}, perr
		}
		u, randoms, err = send(plain)
	}
	if err != nil {
		return bridge.SentRef{}, translateSend(err)
	}
	c.apply(ctx, u)
	return sentRef(u, randoms)
}

// EditMessage implements bridge.Sender. Sending the text a message already
// has is not an error.
func (a *Adapter) EditMessage(ctx context.Context, acct bridge.Account, e bridge.EditRequest) error {
	id, err := strconv.Atoi(e.ID)
	if err != nil {
		return fmt.Errorf("telegram: bad message id %q", e.ID)
	}
	if len(utf16.Encode([]rune(e.Text))) > textMax {
		return fmt.Errorf("%w: the text is over %d characters", bridge.ErrTooLarge, textMax)
	}
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return err
	}
	defer release()
	peer, err := c.inputPeer(ctx, e.Conversation)
	if err != nil {
		return err
	}
	u, err := c.live.api().MessagesEditMessage(ctx, &tg.MessagesEditMessageRequest{
		Peer: peer, ID: id, Message: e.Text, Entities: c.outEntities(e.Entities)})
	if tgerr.Is(err, "MESSAGE_NOT_MODIFIED") {
		return nil
	}
	if err != nil {
		return translateSend(err)
	}
	c.apply(ctx, u)
	return nil
}

// DeleteMessages implements bridge.Sender: it removes the messages for
// everyone in the conversation.
func (a *Adapter) DeleteMessages(ctx context.Context, acct bridge.Account, d bridge.Delete) error {
	ids := make([]int, 0, len(d.IDs))
	for _, raw := range d.IDs {
		id, err := strconv.Atoi(raw)
		if err != nil {
			return fmt.Errorf("telegram: bad message id %q", raw)
		}
		ids = append(ids, id)
	}
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return err
	}
	defer release()
	peer, err := c.inputPeer(ctx, d.Conversation)
	if err != nil {
		return err
	}
	if ch, ok := peer.(*tg.InputPeerChannel); ok {
		_, err = c.live.api().ChannelsDeleteMessages(ctx, &tg.ChannelsDeleteMessagesRequest{
			Channel: &tg.InputChannel{ChannelID: ch.ChannelID, AccessHash: ch.AccessHash}, ID: ids})
	} else {
		_, err = c.live.api().MessagesDeleteMessages(ctx, &tg.MessagesDeleteMessagesRequest{Revoke: true, ID: ids})
	}
	return translateSend(err)
}

// apply gives the updates a send answered with to the update manager, so the
// account's pts does not skip over a message this session sent itself. It
// runs apart: the manager may hand an event to a subscription whose queue is
// full, and the send must not wait for that.
func (c *conn) apply(ctx context.Context, u tg.UpdatesClass) {
	go func() {
		hctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		_ = c.handle(hctx, u)
	}()
}

// outEntities turns the entities of Chat into Telegram's. A kind Telegram
// detects by itself (url, email, hashtag) is left out; a mention needs the
// access hash of the person, which is known only for people seen in the
// dialog list, and is dropped otherwise (the text stays).
func (c *conn) outEntities(ents []bridge.Entity) []tg.MessageEntityClass {
	var out []tg.MessageEntityClass
	for _, e := range ents {
		off, n := e.Offset, e.Length
		switch e.Kind {
		case "bold":
			out = append(out, &tg.MessageEntityBold{Offset: off, Length: n})
		case "italic":
			out = append(out, &tg.MessageEntityItalic{Offset: off, Length: n})
		case "underline":
			out = append(out, &tg.MessageEntityUnderline{Offset: off, Length: n})
		case "strike":
			out = append(out, &tg.MessageEntityStrike{Offset: off, Length: n})
		case "spoiler":
			out = append(out, &tg.MessageEntitySpoiler{Offset: off, Length: n})
		case "code":
			out = append(out, &tg.MessageEntityCode{Offset: off, Length: n})
		case "pre":
			out = append(out, &tg.MessageEntityPre{Offset: off, Length: n})
		case "link":
			out = append(out, &tg.MessageEntityTextURL{Offset: off, Length: n, URL: e.URL})
		case "mention":
			id, err := strconv.ParseInt(e.Mention, 10, 64)
			if err != nil {
				continue
			}
			c.mu.Lock()
			hash, known := c.hashes[id]
			c.mu.Unlock()
			if known {
				out = append(out, &tg.InputMessageEntityMentionName{Offset: off, Length: n,
					UserID: &tg.InputUser{UserID: id, AccessHash: hash}})
			}
		}
	}
	return out
}

// translateSend turns a Telegram error of a send, edit or delete into what
// the engine understands: a throttle waits, a refusal fails the one message,
// and a dead session stops the account. Anything else is returned as it is
// (and tried again).
func translateSend(err error) error {
	if err == nil {
		return nil
	}
	if err = translate(err); err == nil {
		return nil
	}
	rpc, ok := tgerr.As(err)
	if !ok {
		return err
	}
	switch rpc.Type {
	case "SLOWMODE_WAIT":
		return &bridge.RateLimitError{RetryAfter: time.Duration(rpc.Argument) * time.Second}
	case "CHAT_WRITE_FORBIDDEN", "CHAT_ADMIN_REQUIRED", "CHAT_SEND_PLAIN_FORBIDDEN", "CHAT_SEND_MEDIA_FORBIDDEN",
		"CHAT_SEND_PHOTOS_FORBIDDEN", "CHAT_SEND_DOCS_FORBIDDEN", "CHAT_SEND_AUDIOS_FORBIDDEN", "CHAT_SEND_VIDEOS_FORBIDDEN",
		"CHAT_SEND_VOICES_FORBIDDEN", "CHAT_RESTRICTED", "USER_BANNED_IN_CHANNEL", "USER_IS_BLOCKED", "USER_PRIVACY_RESTRICTED",
		"USER_BOT_BLOCKED", "CHANNEL_PRIVATE", "CHANNEL_INVALID", "PEER_ID_INVALID", "INPUT_USER_DEACTIVATED",
		"MESSAGE_AUTHOR_REQUIRED", "MESSAGE_DELETE_FORBIDDEN", "EDIT_MESSAGE_FORBIDDEN", "CHAT_ID_INVALID",
		"TOPIC_CLOSED", "TOPIC_DELETED", "TOPIC_ID_INVALID", "TOPIC_NOT_MODIFIED":
		return fmt.Errorf("%w: %s", bridge.ErrNotAllowed, rpc.Type)
	case "MESSAGE_EDIT_TIME_EXPIRED":
		return fmt.Errorf("%w: %s", bridge.ErrEditExpired, rpc.Type)
	case "MESSAGE_TOO_LONG", "MEDIA_CAPTION_TOO_LONG", "FILE_PARTS_INVALID", "FILE_PART_TOO_BIG":
		return fmt.Errorf("%w: %s", bridge.ErrTooLarge, rpc.Type)
	}
	return err
}

// sentRef reads what a send created out of the updates Telegram answered
// with: the id of each message, matched to the random ids sent, and the date.
// A private chat is answered with a short update that holds just the id.
func sentRef(u tg.UpdatesClass, randoms []int64) (bridge.SentRef, error) {
	ref := bridge.SentRef{}
	byRandom := map[int64]int{}
	var created []int
	switch v := u.(type) {
	case *tg.UpdateShortSentMessage:
		return bridge.SentRef{IDs: []string{strconv.Itoa(v.ID)}, Date: time.Unix(int64(v.Date), 0)}, nil
	case *tg.Updates:
		ref.Date = time.Unix(int64(v.Date), 0)
		for _, x := range v.Updates {
			switch up := x.(type) {
			case *tg.UpdateMessageID:
				byRandom[up.RandomID] = up.ID
			case *tg.UpdateNewMessage:
				if msg, ok := up.Message.(*tg.Message); ok && msg.Out {
					created = append(created, msg.ID)
				}
			case *tg.UpdateNewChannelMessage:
				if msg, ok := up.Message.(*tg.Message); ok && msg.Out {
					created = append(created, msg.ID)
				}
			}
		}
	default:
		return ref, fmt.Errorf("telegram: unexpected answer to a send: %T", u)
	}
	for _, r := range randoms {
		id, ok := byRandom[r]
		if !ok {
			ids := make([]string, len(created))
			for i, id := range created {
				ids[i] = strconv.Itoa(id)
			}
			if len(ids) != len(randoms) {
				return ref, errors.New("telegram: the answer to a send names no message")
			}
			ref.IDs = ids
			return ref, nil
		}
		ref.IDs = append(ref.IDs, strconv.Itoa(id))
	}
	return ref, nil
}
