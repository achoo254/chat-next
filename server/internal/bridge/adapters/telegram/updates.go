package telegram

import (
	"context"
	"errors"
	"strconv"
	"time"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/telegram/updates"
	"github.com/gotd/td/tg"
)

// Subscribe implements bridge.Adapter: the account's live updates (new,
// edited and deleted messages of every conversation), until ctx ends.
//
// Telegram's update manager keeps the common box (pts, qts, seq, date) and
// the pts of each channel, fetching what was missed with getDifference. That
// state is the blob acct.State: every event carries the state after it, and
// a subscription started with it resumes where the last committed event
// left off. An empty state starts from the present. When Telegram cannot
// replay the gap (difference too long) Subscribe returns
// bridge.ErrGapTooLarge and the engine imports the history windows again.
func (a *Adapter) Subscribe(ctx context.Context, acct bridge.Account, out chan<- bridge.Event) error {
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return err
	}
	defer release()

	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	state := loadState(acct.State)
	self := c.live.self

	emit := func(ctx context.Context, ev bridge.Event) error {
		ev.State = state.Snapshot()
		select {
		case out <- ev:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	message := func(ctx context.Context, e tg.Entities, raw tg.MessageClass, edit bool) error {
		book := fromEntities(e)
		if conv, topic, created, ok := book.topicAction(raw); ok {
			if edit {
				return nil
			}
			return emitTopic(ctx, c, emit, raw, conv, topic, created)
		}
		m, ok := book.mapMessage(raw, self)
		if !ok {
			return nil
		}
		if edit {
			return emit(ctx, bridge.Event{Edit: &bridge.Edit{Message: m}})
		}
		return emit(ctx, bridge.Event{Message: &m})
	}
	d := tg.NewUpdateDispatcher()
	d.OnNewMessage(func(ctx context.Context, e tg.Entities, u *tg.UpdateNewMessage) error {
		return message(ctx, e, u.Message, false)
	})
	d.OnNewChannelMessage(func(ctx context.Context, e tg.Entities, u *tg.UpdateNewChannelMessage) error {
		return message(ctx, e, u.Message, false)
	})
	d.OnEditMessage(func(ctx context.Context, e tg.Entities, u *tg.UpdateEditMessage) error {
		return message(ctx, e, u.Message, true)
	})
	d.OnEditChannelMessage(func(ctx context.Context, e tg.Entities, u *tg.UpdateEditChannelMessage) error {
		return message(ctx, e, u.Message, true)
	})
	registerPins(d, c, emit)
	d.OnDeleteMessages(func(ctx context.Context, _ tg.Entities, u *tg.UpdateDeleteMessages) error {
		// A delete in a private chat or basic group names no chat: the core
		// finds the message by its id (ids are unique per account there).
		return emit(ctx, bridge.Event{Delete: &bridge.Delete{IDs: idStrings(u.Messages)}})
	})
	d.OnDeleteChannelMessages(func(ctx context.Context, _ tg.Entities, u *tg.UpdateDeleteChannelMessages) error {
		return emit(ctx, bridge.Event{Delete: &bridge.Delete{
			Conversation: prefixChannel + strconv.FormatInt(u.ChannelID, 10), IDs: idStrings(u.Messages)}})
	})

	tooLong := func() { cancel(bridge.ErrGapTooLarge) }
	mgr := updates.New(updates.Config{
		Handler: d, Storage: state, AccessHasher: state, StopOnApplyError: true,
		OnTooLong: tooLong, OnChannelTooLong: func(int64) { tooLong() },
	})
	c.setManager(mgr)
	defer c.setManager(nil)

	err = mgr.Run(ctx, c.live.api(), self, updates.AuthOptions{Forget: len(acct.State) == 0})
	if cause := context.Cause(ctx); errors.Is(cause, bridge.ErrGapTooLarge) {
		return cause
	}
	if err == nil {
		err = c.live.failure()
	}
	return translate(err)
}

func idStrings(ids []int) []string {
	out := make([]string, len(ids))
	for i, id := range ids {
		out[i] = strconv.Itoa(id)
	}
	return out
}

// emitTopic turns the service message of a topic that was opened or changed
// into a topic event. It asks Telegram what the topic is now (the message names
// only what changed). If that fails for a new topic, the event is made from the
// service message itself; a change that cannot be read is dropped, and the
// engine learns the topic from the next listing.
func emitTopic(ctx context.Context, c *conn, emit func(context.Context, bridge.Event) error, raw tg.MessageClass, conv, topic string, created bool) error {
	t, err := c.topicNow(ctx, conv, topic)
	if err != nil {
		s, ok := raw.(*tg.MessageService)
		action, isCreate := tg.MessageActionClass(nil), false
		if ok {
			action = s.Action
		}
		var title string
		var color int
		if a, is := action.(*tg.MessageActionTopicCreate); is {
			isCreate, title, color = true, a.Title, a.IconColor
		}
		if !created || !isCreate {
			return nil
		}
		t = bridge.Topic{ID: topic, Title: title, IconColor: color, Created: time.Unix(int64(s.Date), 0)}
	}
	return emit(ctx, bridge.Event{Topic: &bridge.TopicChange{Conversation: conv, Topic: t}})
}
