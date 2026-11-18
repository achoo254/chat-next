package engine

import (
	"context"

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
