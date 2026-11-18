package telegram

import (
	"context"
	"fmt"
	"strconv"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
)

const (
	pinPageMax  = 100 // Telegram's page size for a search
	pinPagesMax = 20  // a conversation never holds anywhere near this many pins
)

var _ bridge.PinReader = (*Adapter)(nil)

// ListPinned implements bridge.PinReader: the ids of the pinned messages of a
// conversation, newest first. Messages that are only service messages (the
// "pinned a message" line) are never in the pinned filter.
func (a *Adapter) ListPinned(ctx context.Context, acct bridge.Account, conv string) ([]string, error) {
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return nil, err
	}
	defer release()
	peer, err := c.inputPeer(ctx, conv)
	if err != nil {
		return nil, err
	}
	ids, err := listPinned(ctx, func(offsetID int) ([]int, error) {
		res, err := c.live.api().MessagesSearch(ctx, &tg.MessagesSearchRequest{
			Peer: peer, Filter: &tg.InputMessagesFilterPinned{}, OffsetID: offsetID, Limit: pinPageMax})
		if err != nil {
			return nil, err
		}
		var out []int
		for _, m := range messagesOf(res) {
			out = append(out, m.ID)
		}
		return out, nil
	})
	return idStrings(ids), translate(err)
}

// messagesOf lists the plain messages of a search or history result.
func messagesOf(res tg.MessagesMessagesClass) []*tg.Message {
	var raw []tg.MessageClass
	switch v := res.(type) {
	case *tg.MessagesMessages:
		raw = v.Messages
	case *tg.MessagesMessagesSlice:
		raw = v.Messages
	case *tg.MessagesChannelMessages:
		raw = v.Messages
	}
	var out []*tg.Message
	for _, m := range raw {
		if mm, ok := m.(*tg.Message); ok {
			out = append(out, mm)
		}
	}
	return out
}

// listPinned reads the pinned ids page by page; fetch answers the page of ids
// older than offsetID (0 for the first page), newest first.
func listPinned(ctx context.Context, fetch func(offsetID int) ([]int, error)) ([]int, error) {
	var out []int
	offset := 0
	for page := 0; page < pinPagesMax; page++ {
		ids, err := fetch(offset)
		if err != nil {
			return nil, err
		}
		out = append(out, ids...)
		if len(ids) < pinPageMax {
			return out, nil
		}
		offset = ids[len(ids)-1]
		if err := ctx.Err(); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// registerPins makes the dispatcher turn the pin updates of Telegram into
// events: messages pinned or unpinned, and a topic pinned or unpinned (which
// reaches the engine as a change of that topic).
func registerPins(d tg.UpdateDispatcher, c *conn, emit func(context.Context, bridge.Event) error) {
	d.OnPinnedChannelMessages(func(ctx context.Context, _ tg.Entities, u *tg.UpdatePinnedChannelMessages) error {
		return emit(ctx, bridge.Event{Pin: &bridge.PinChange{
			Conversation: prefixChannel + strconv.FormatInt(u.ChannelID, 10), IDs: idStrings(u.Messages), Pinned: u.Pinned}})
	})
	d.OnPinnedMessages(func(ctx context.Context, _ tg.Entities, u *tg.UpdatePinnedMessages) error {
		conv := convID(u.Peer)
		if conv == "" {
			return nil
		}
		return emit(ctx, bridge.Event{Pin: &bridge.PinChange{Conversation: conv, IDs: idStrings(u.Messages), Pinned: u.Pinned}})
	})
	d.OnPinnedForumTopic(func(ctx context.Context, _ tg.Entities, u *tg.UpdatePinnedForumTopic) error {
		conv := convID(u.Peer)
		if conv == "" {
			return nil
		}
		// The update names only the topic and the flag; ask Telegram for the
		// topic as it is, as for any other change of a topic.
		t, err := c.topicNow(ctx, conv, strconv.Itoa(u.TopicID))
		if err != nil {
			return nil // the engine learns the topic from its next listing
		}
		return emit(ctx, bridge.Event{Topic: &bridge.TopicChange{Conversation: conv, Topic: t}})
	})
}

var _ bridge.Pinner = (*Adapter)(nil)

// translatePin is translateSend plus what only a pin can answer: pinning what is
// already pinned (or unpinning what is not) is done, not a failure; a pin the
// group will not take is a refusal that retrying cannot change.
func translatePin(err error) error {
	if err == nil {
		return nil
	}
	if rpc, ok := tgerr.As(err); ok {
		switch rpc.Type {
		case "USER_NOT_PARTICIPANT", "INVITE_REVOKED_MISSING", "CHAT_NOT_MODIFIED", "CHAT_ABOUT_NOT_MODIFIED", "CHAT_TITLE_NOT_MODIFIED", "PINNED_TOPIC_NOT_MODIFIED", "TOPIC_NOT_MODIFIED":
			return nil
		case "CHAT_ABOUT_TOO_LONG", "CHAT_TITLE_EMPTY":
			return fmt.Errorf("%w: %s", bridge.ErrTooLarge, rpc.Type)
		case "CHAT_CREATOR_REQUIRED", "USER_ADMIN_INVALID", "USER_CREATOR", "RIGHT_FORBIDDEN", "USER_PRIVACY_RESTRICTED", "BOT_GROUPS_BLOCKED":
			return fmt.Errorf("%w: %s", bridge.ErrNotAllowed, rpc.Type)
		case "PIN_RESTRICTED", "PINNED_TOO_MUCH", "MESSAGE_ID_INVALID", "TOPIC_CLOSED":
			return fmt.Errorf("%w: %s", bridge.ErrNotAllowed, rpc.Type)
		}
	}
	return translateSend(err)
}

// PinMessage implements bridge.Pinner. Pinning is silent: it does not notify the members.
func (a *Adapter) PinMessage(ctx context.Context, acct bridge.Account, conv, id string, pinned bool) error {
	mid, err := strconv.Atoi(id)
	if err != nil {
		return fmt.Errorf("telegram: bad message id %q", id)
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
	_, err = c.live.api().MessagesUpdatePinnedMessage(ctx, &tg.MessagesUpdatePinnedMessageRequest{Peer: peer, ID: mid, Unpin: !pinned, Silent: true})
	return translatePin(err)
}

// PinTopic implements bridge.Pinner.
func (a *Adapter) PinTopic(ctx context.Context, acct bridge.Account, conv, topic string, pinned bool) error {
	tid, err := strconv.Atoi(topic)
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
	_, err = c.live.api().MessagesUpdatePinnedForumTopic(ctx, &tg.MessagesUpdatePinnedForumTopicRequest{Peer: peer, TopicID: tid, Pinned: pinned})
	return translatePin(err)
}
