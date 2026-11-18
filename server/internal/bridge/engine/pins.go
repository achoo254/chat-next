package engine

import (
	"context"
	"time"

	"app.local/server/internal/bridge"
	"app.local/server/internal/chat"
)

// pinReader is the adapter's pin list when it offers one.
func (r *runner) pinReader() (bridge.PinReader, bool) {
	pr, ok := r.adapter.(bridge.PinReader)
	if !ok || !r.adapter.Capabilities().Has(bridge.CapPins) {
		return nil, false
	}
	return pr, true
}

// syncPins pins in Chat the messages the other app has pinned. It only adds:
// a pin made in Chat is never removed by it, and one removed in the other app
// while the sync was not listening arrives as an event or not at all. A pinned
// message older than the imported window is not in Chat and is skipped.
func (r *runner) syncPins(ctx context.Context, l *chatLink) error {
	pr, ok := r.pinReader()
	if !ok {
		return nil
	}
	ids, err := retryRateLimit(ctx, func() ([]string, error) { return pr.ListPinned(ctx, r.acct, l.ExternalChat) })
	if err != nil {
		return err
	}
	var seqs []int64
	skipped := 0
	for _, id := range ids {
		have, err := lookupMessage(ctx, r.e.db.pool, r.account.ID, l.ExternalChat, id)
		if err != nil {
			return err
		}
		if have == nil {
			skipped++
			continue
		}
		seqs = append(seqs, have.Seq)
	}
	if skipped > 0 {
		r.logger.Info("pinned messages outside the imported history are not pinned in Chat", "chat_id", l.ChatID, "skipped", skipped)
	}
	if len(seqs) == 0 {
		return nil
	}
	return r.withLink(ctx, l, func(it *chat.ImportTx) error {
		for _, seq := range seqs {
			if _, err := it.SetPinned(ctx, seq, true); err != nil {
				return err
			}
		}
		return nil
	})
}

// onPin applies a pin or unpin reported live.
func (r *runner) onPin(ctx context.Context, ev bridge.Event, pc bridge.PinChange) (bool, error) {
	l := r.links[pc.Conversation]
	if l == nil || !l.BackfillDone {
		return false, nil
	}
	var seqs []int64
	for _, id := range pc.IDs {
		have, err := lookupMessage(ctx, r.e.db.pool, r.account.ID, pc.Conversation, id)
		if err != nil {
			return false, err
		}
		if have != nil {
			seqs = append(seqs, have.Seq)
		}
	}
	err := r.withLink(ctx, l, func(it *chat.ImportTx) error {
		for _, seq := range seqs {
			if _, err := it.SetPinned(ctx, seq, pc.Pinned); err != nil {
				return err
			}
		}
		return saveState(ctx, it.Tx(), r.account.ID, ev.State)
	})
	return true, err
}

// doPin sends the pin state of a message or a topic (topic: the row's seq is
// the topic id of the chat). A pin the other app refuses for good (no right to
// pin, too many pinned) is put back in Chat, so Chat never shows a pin the other
// app does not have; the row stays failed with the reason.
func (r *runner) doPin(ctx context.Context, sender bridge.Sender, h *outboxRow, topic bool) error {
	db := r.e.db
	pinner, ok := sender.(bridge.Pinner)
	if !ok || !r.adapter.Capabilities().Has(bridge.CapPins) {
		return r.failPin(ctx, h, topic, "pin_unsupported: this app cannot pin from Chat")
	}
	var conv, ext string
	if topic {
		id, found, err := externalTopic(ctx, db.pool, r.account.ID, h.ExternalChat, h.Seq)
		if err != nil {
			return err
		}
		if !found {
			return db.setOutbox(ctx, []int64{h.ID}, "cancelled", "", time.Time{})
		}
		conv, ext = h.ExternalChat, id
	} else {
		k, err := externalOf(ctx, db.pool, h.ChatID, h.Seq)
		if err != nil {
			return err
		}
		if k == nil {
			return db.setOutbox(ctx, []int64{h.ID}, "cancelled", "", time.Time{})
		}
		conv, ext = k.chat, k.msg
	}
	if err := db.startSendingState(ctx, h); err != nil {
		return err
	}
	var err error
	if topic {
		err = pinner.PinTopic(ctx, r.acct, conv, ext, h.Pinned)
	} else {
		err = pinner.PinMessage(ctx, r.acct, conv, ext, h.Pinned)
	}
	if err != nil {
		if serr := r.settleCall(ctx, []*outboxRow{h}, err); serr != nil {
			return serr
		}
		var status string
		if qerr := db.pool.QueryRow(ctx, `SELECT status FROM external_outbox WHERE id = $1`, h.ID).Scan(&status); qerr != nil {
			return qerr
		}
		if status == "failed" {
			return r.putPinBack(ctx, h, topic)
		}
		return nil
	}
	return db.setOutbox(ctx, []int64{h.ID}, "sent", "", time.Time{})
}

func (r *runner) failPin(ctx context.Context, h *outboxRow, topic bool, reason string) error {
	if err := r.e.db.setOutbox(ctx, []int64{h.ID}, "failed", reason, time.Time{}); err != nil {
		return err
	}
	return r.putPinBack(ctx, h, topic)
}

// putPinBack returns the pin in Chat to the state it had before the change that
// the other app refused.
func (r *runner) putPinBack(ctx context.Context, h *outboxRow, topic bool) error {
	l := r.links[h.ExternalChat]
	if l == nil {
		return nil
	}
	return r.withLink(ctx, l, func(it *chat.ImportTx) error {
		if topic {
			_, err := it.SetTopicPinned(ctx, h.Seq, !h.Pinned)
			return err
		}
		_, err := it.SetPinned(ctx, h.Seq, !h.Pinned)
		return err
	})
}
