package engine

import (
	"context"
	"time"

	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/feature"
)

// A feature of the bridge is a handler: what it does with the events of the other
// app (inbound) and with the rows Chat queued for it (outbound ops). The engine
// knows features only through this table, so a new feature is a new entry and its
// code, not a change to how events and rows are dispatched. Which chats a feature
// is on for, and in which direction, is decided before a handler runs (see
// dispatch and sendRow).
type handler struct {
	feature feature.Feature
	// match tells whether an event is of this feature and which conversation it is
	// about (empty when it names none: it is then applied whatever the setting).
	match func(ev bridge.Event) (conversation string, ok bool)
	// apply applies the event; saved says the account state went into the same
	// transaction as the change.
	apply func(r *runner, ctx context.Context, ev bridge.Event) (saved bool, err error)
	// ops are the outbox ops of the feature, by name.
	ops map[string]func(r *runner, ctx context.Context, h *outboxRow) error
	// poll asks the other app for the state of the feature, for what it does not
	// tell when it changes; called on a timer for an account that is connected.
	poll func(r *runner, ctx context.Context) error
}

// noEvents is the match of a feature that is read by polling and has no event.
func noEvents(bridge.Event) (string, bool) { return "", false }

var handlers = []handler{
	{
		feature: feature.Invites,
		match:   noEvents,
		ops: map[string]func(*runner, context.Context, *outboxRow) error{
			"invite_create": func(r *runner, ctx context.Context, h *outboxRow) error { return r.doInviteOp(ctx, h) },
			"invite_revoke": func(r *runner, ctx context.Context, h *outboxRow) error { return r.doInviteOp(ctx, h) },
		},
		poll: func(r *runner, ctx context.Context) error { return r.pollInvites(ctx) },
	},
	{
		feature: feature.Lifecycle,
		match:   noEvents,
		ops: map[string]func(*runner, context.Context, *outboxRow) error{
			"group_leave":  func(r *runner, ctx context.Context, h *outboxRow) error { return r.doGroupAction(ctx, h) },
			"group_delete": func(r *runner, ctx context.Context, h *outboxRow) error { return r.doGroupAction(ctx, h) },
		},
	},
	{
		feature: feature.Members,
		match:   noEvents,
		ops: map[string]func(*runner, context.Context, *outboxRow) error{
			"member_remove": func(r *runner, ctx context.Context, h *outboxRow) error { return r.doMemberAction(ctx, h) },
			"member_admin":  func(r *runner, ctx context.Context, h *outboxRow) error { return r.doMemberAction(ctx, h) },
			"member_add":    func(r *runner, ctx context.Context, h *outboxRow) error { return r.doMemberAction(ctx, h) },
			"member_perms":  func(r *runner, ctx context.Context, h *outboxRow) error { return r.doMemberAction(ctx, h) },
		},
		poll: func(r *runner, ctx context.Context) error { return r.pollMembers(ctx) },
	},
	{
		feature: feature.Info,
		match:   noEvents,
		ops: map[string]func(*runner, context.Context, *outboxRow) error{
			"set_info": func(r *runner, ctx context.Context, h *outboxRow) error { return r.doInfo(ctx, h) },
		},
		poll: func(r *runner, ctx context.Context) error { return r.pollInfo(ctx) },
	},
	{
		feature: feature.Notify,
		match:   noEvents,
		ops: map[string]func(*runner, context.Context, *outboxRow) error{
			"set_mute": func(r *runner, ctx context.Context, h *outboxRow) error { return r.doDialogState(ctx, h) },
		},
		poll: func(r *runner, ctx context.Context) error { return r.pollDialogs(ctx) },
	},
	{
		feature: feature.Dialog,
		match:   noEvents,
		ops: map[string]func(*runner, context.Context, *outboxRow) error{
			"set_dialog_pin":  func(r *runner, ctx context.Context, h *outboxRow) error { return r.doDialogState(ctx, h) },
			"set_unread_mark": func(r *runner, ctx context.Context, h *outboxRow) error { return r.doDialogState(ctx, h) },
		},
	},
	{
		feature: feature.Messages,
		// Messages always come in; the chat decides only whether Chat sends back.
		match: func(ev bridge.Event) (string, bool) {
			return "", ev.Message != nil || ev.Edit != nil || ev.Delete != nil
		},
		apply: func(r *runner, ctx context.Context, ev bridge.Event) (bool, error) {
			switch {
			case ev.Message != nil:
				return r.onMessage(ctx, ev, *ev.Message)
			case ev.Edit != nil:
				return r.onEdit(ctx, ev, ev.Edit.Message)
			}
			return r.onDelete(ctx, ev, *ev.Delete)
		},
		ops: map[string]func(*runner, context.Context, *outboxRow) error{
			"send":   func(r *runner, ctx context.Context, h *outboxRow) error { return r.withSender(ctx, h, r.doSend) },
			"edit":   func(r *runner, ctx context.Context, h *outboxRow) error { return r.withSender(ctx, h, r.doEdit) },
			"delete": func(r *runner, ctx context.Context, h *outboxRow) error { return r.withSender(ctx, h, r.doDelete) },
		},
	},
	{
		feature: feature.Topics,
		match: func(ev bridge.Event) (string, bool) {
			if ev.Topic == nil {
				return "", false
			}
			return ev.Topic.Conversation, true
		},
		apply: func(r *runner, ctx context.Context, ev bridge.Event) (bool, error) {
			return r.onTopic(ctx, ev, *ev.Topic)
		},
		ops: map[string]func(*runner, context.Context, *outboxRow) error{
			"set_topic":    func(r *runner, ctx context.Context, h *outboxRow) error { return r.doTopicEdit(ctx, h) },
			"create_topic": func(r *runner, ctx context.Context, h *outboxRow) error { return r.doTopicCreate(ctx, h) },
			"pin_topic": func(r *runner, ctx context.Context, h *outboxRow) error {
				return r.withSender(ctx, h, func(ctx context.Context, s bridge.Sender, h *outboxRow) error { return r.doPin(ctx, s, h, true) })
			},
		},
	},
	{
		feature: feature.Pins,
		match: func(ev bridge.Event) (string, bool) {
			if ev.Pin == nil {
				return "", false
			}
			return ev.Pin.Conversation, true
		},
		apply: func(r *runner, ctx context.Context, ev bridge.Event) (bool, error) { return r.onPin(ctx, ev, *ev.Pin) },
		ops: map[string]func(*runner, context.Context, *outboxRow) error{
			"pin_message": func(r *runner, ctx context.Context, h *outboxRow) error {
				return r.withSender(ctx, h, func(ctx context.Context, s bridge.Sender, h *outboxRow) error { return r.doPin(ctx, s, h, false) })
			},
		},
	},
	{
		feature: feature.Reactions,
		match: func(ev bridge.Event) (string, bool) {
			if ev.Reactions == nil {
				return "", false
			}
			return ev.Reactions.Conversation, true
		},
		apply: func(r *runner, ctx context.Context, ev bridge.Event) (bool, error) {
			return r.onReactions(ctx, ev, *ev.Reactions)
		},
		ops: map[string]func(*runner, context.Context, *outboxRow) error{
			"set_reaction": func(r *runner, ctx context.Context, h *outboxRow) error { return r.doReaction(ctx, h) },
		},
		poll: func(r *runner, ctx context.Context) error { return r.pollReactions(ctx) },
	},
	{
		feature: feature.Read,
		match: func(ev bridge.Event) (string, bool) {
			if ev.Seen != nil {
				return ev.Seen.Conversation, true
			}
			if ev.Read == nil {
				return "", false
			}
			return ev.Read.Conversation, true
		},
		apply: func(r *runner, ctx context.Context, ev bridge.Event) (bool, error) {
			if ev.Seen != nil {
				return r.onSeen(ctx, ev, *ev.Seen)
			}
			return r.onRead(ctx, ev, *ev.Read)
		},
		ops: map[string]func(*runner, context.Context, *outboxRow) error{
			"mark_read": func(r *runner, ctx context.Context, h *outboxRow) error { return r.doMarkRead(ctx, h) },
		},
	},
}

// opHandler finds the handler that owns an outbox op.
func opHandler(op string) (*handler, func(*runner, context.Context, *outboxRow) error) {
	for i := range handlers {
		if fn, ok := handlers[i].ops[op]; ok {
			return &handlers[i], fn
		}
	}
	return nil, nil
}

// dispatch gives an event to the handler of its feature, unless the feature does
// not receive for the chat the event is about (the caller then keeps the account
// state, as for any event nothing was saved for). An event no handler takes is ignored.
func (r *runner) dispatch(ctx context.Context, ev bridge.Event) (saved bool, err error) {
	for i := range handlers {
		h := &handlers[i]
		conv, ok := h.match(ev)
		if !ok {
			continue
		}
		if l := r.links[conv]; conv != "" && l != nil {
			dir, err := r.e.db.featureDirection(ctx, r.account.ID, l.ExternalChat, h.feature)
			if err != nil {
				return false, err
			}
			if !dir.Receives() {
				return false, nil
			}
		}
		return h.apply(r, ctx, ev)
	}
	return false, nil
}

// withSender runs op with the adapter's Sender, or fails the row when the app
// cannot be written to.
func (r *runner) withSender(ctx context.Context, h *outboxRow, op func(context.Context, bridge.Sender, *outboxRow) error) error {
	sender, ok := r.adapter.(bridge.Sender)
	if !ok || !r.adapter.Capabilities().Has(bridge.CapSend) {
		return r.e.db.setOutbox(ctx, []int64{h.ID}, "failed", "send_unsupported: this app cannot be written to from Chat", time.Time{})
	}
	return op(ctx, sender, h)
}
