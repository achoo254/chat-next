package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/feature"
	"app.local/server/internal/chat"
)

// dialogBatch is how many conversations one ask for their state names.
const dialogBatch = 50

// pendingOp says whether a row of op for the chat still waits to be sent (or is on
// its way): the state in Chat is then newer than the one the other app has, and
// reading the other app must not put it back.
func (d *db) pendingOp(ctx context.Context, chatID int64, op string) (bool, error) {
	var n int
	if err := d.pool.QueryRow(ctx, `SELECT count(*) FROM external_outbox WHERE chat_id = $1 AND op = $2 AND status IN ('pending', 'sending')`, chatID, op).Scan(&n); err != nil {
		return false, fmt.Errorf("bridge: pending op: %w", err)
	}
	return n > 0, nil
}

// pollDialogs reads the state of the synced chats in the other app (mute, pinned,
// marked unread) and makes Chat match it: the other app is the source, so a change
// Chat could not send (refused, or the feature was switched off meanwhile) does not
// leave Chat showing a state the other app does not have. A state is not touched
// while Chat has a change of that kind waiting to go out. Reading and sending run
// in the same goroutine, so a state read is never older than one already sent.
func (r *runner) pollDialogs(ctx context.Context) error {
	reader, ok := r.adapter.(bridge.DialogReader)
	if !ok {
		return nil
	}
	sup := bridge.FeaturesOf(r.adapter)
	var convs []string
	for conv, l := range r.links {
		if !l.BackfillDone {
			continue
		}
		for _, f := range []feature.Feature{feature.Notify, feature.Dialog} {
			if !sup[f].In {
				continue
			}
			dir, err := r.e.db.featureDirection(ctx, r.account.ID, l.ExternalChat, f)
			if err != nil {
				return err
			}
			if dir.Receives() {
				convs = append(convs, conv)
				break
			}
		}
	}
	for start := 0; start < len(convs); start += dialogBatch {
		batch := convs[start:min(start+dialogBatch, len(convs))]
		states, err := retryRateLimit(ctx, func() (map[string]bridge.DialogState, error) { return reader.DialogStates(ctx, r.acct, batch) })
		if err != nil {
			return err
		}
		for _, conv := range batch {
			st, ok := states[conv]
			if !ok {
				continue
			}
			if err := r.applyDialogState(ctx, r.links[conv], st); err != nil {
				if errors.Is(err, errSkipDialog) {
					continue
				}
				return err
			}
		}
	}
	return nil
}

var errSkipDialog = errors.New("bridge: dialog state skipped")

func (r *runner) applyDialogState(ctx context.Context, l *chatLink, st bridge.DialogState) error {
	type field struct {
		feat  feature.Feature
		op    string
		apply func(it *chat.ImportTx) error
	}
	ignoreErr := func(err error) error {
		// The other app may allow more pinned chats than Chat: that one stays as it is.
		if err != nil && isSkippable(err) {
			r.logger.Warn("dialog state skipped", "reason", err.Error(), "chat_id", l.ChatID)
			return nil
		}
		return err
	}
	fields := []field{
		{feature.Notify, "set_mute", func(it *chat.ImportTx) error {
			_, err := it.SetOwnerMute(ctx, st.MuteUntil)
			return err
		}},
		{feature.Dialog, "set_dialog_pin", func(it *chat.ImportTx) error {
			_, err := it.SetOwnerDialogPinned(ctx, st.Pinned)
			return ignoreErr(err)
		}},
		{feature.Dialog, "set_unread_mark", func(it *chat.ImportTx) error {
			_, err := it.SetOwnerUnreadMark(ctx, st.UnreadMark)
			return err
		}},
	}
	var todo []field
	for _, f := range fields {
		dir, err := r.e.db.featureDirection(ctx, r.account.ID, l.ExternalChat, f.feat)
		if err != nil {
			return err
		}
		if !dir.Receives() {
			continue
		}
		if pending, err := r.e.db.pendingOp(ctx, l.ChatID, f.op); err != nil {
			return err
		} else if pending {
			continue
		}
		todo = append(todo, f)
	}
	if len(todo) > 0 {
		if err := r.withLink(ctx, l, func(it *chat.ImportTx) error {
			for _, f := range todo {
				if err := f.apply(it); err != nil {
					return err
				}
			}
			return nil
		}); err != nil {
			return err
		}
	}
	return nil
}

// doDialogState sends the state wanted by a row of mute, pinned or unread mark.
func (r *runner) doDialogState(ctx context.Context, h *outboxRow) error {
	db := r.e.db
	writer, ok := r.adapter.(bridge.DialogWriter)
	if !ok {
		return db.setOutbox(ctx, []int64{h.ID}, "failed", "dialog_unsupported: this app cannot take this from Chat", time.Time{})
	}
	if err := db.startSendingState(ctx, h); err != nil {
		return err
	}
	var p struct {
		Until  int64 `json:"until"`
		Pinned bool  `json:"pinned"`
		Unread bool  `json:"unread"`
	}
	if err := json.Unmarshal(h.Payload, &p); err != nil {
		return db.setOutbox(ctx, []int64{h.ID}, "failed", "bad payload", time.Time{})
	}
	var err error
	switch h.Op {
	case "set_mute":
		err = writer.SetMute(ctx, r.acct, h.ExternalChat, p.Until)
	case "set_dialog_pin":
		err = writer.SetDialogPinned(ctx, r.acct, h.ExternalChat, p.Pinned)
	case "set_unread_mark":
		err = writer.SetUnreadMark(ctx, r.acct, h.ExternalChat, p.Unread)
	}
	if err != nil {
		return r.settleCall(ctx, []*outboxRow{h}, err)
	}
	return db.setOutbox(ctx, []int64{h.ID}, "sent", "", time.Time{})
}

// pollAll runs the poll of every feature that has one.
func (r *runner) pollAll(ctx context.Context) error {
	for i := range handlers {
		h := &handlers[i]
		if h.poll == nil {
			continue
		}
		if err := h.poll(r, ctx); err != nil {
			return err
		}
	}
	return nil
}
