package push

import (
	"cmp"
	"context"
	"fmt"
	"slices"
	"time"

	"app.local/server/internal/chat"
	"github.com/jackc/pgx/v5"
)

// Consumer timings and limits.
const (
	// CursorName is the consumer's outbox_cursors row.
	CursorName = "push"
	passBatch  = 500
	tickEvery  = time.Second
	// gapTTL: an outbox id skipped by the cursor that has not appeared by
	// then belongs to a rolled-back transaction.
	gapTTL = 30 * time.Second
	maxGap = 10000
	// staleAfter: older messages are not pushed (after an outage the app
	// shows them when opened).
	staleAfter = 15 * time.Minute
)

// Run consumes the outbox and sends pushes until ctx ends; queued sends
// get drainTimeout to finish. It returns at once when Web Push is off.
func (s *Service) Run(ctx context.Context) {
	if s.queue == nil {
		return
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.queue.run(ctx)
	}()
	defer func() { <-done }()
	ticker := time.NewTicker(tickEvery)
	defer ticker.Stop()
	for {
		if err := s.CatchUp(ctx); err != nil && ctx.Err() == nil {
			s.logger.Error("push consumer failed", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-s.kick:
		case <-ticker.C:
		}
	}
}

// CatchUp runs consumer passes until the outbox head is reached.
func (s *Service) CatchUp(ctx context.Context) error {
	if s.queue == nil {
		return nil
	}
	for {
		n, err := s.pass(ctx)
		if err != nil || n < passBatch {
			return err
		}
	}
}

// pass consumes one batch in one transaction holding the cursor row and
// queues the sends once the cursor moved: a crash in between loses those
// pushes rather than sending them twice. It returns how many new outbox
// rows it read.
func (s *Service) pass(ctx context.Context) (int, error) {
	s.passMu.Lock()
	defer s.passMu.Unlock()
	var read int
	var jobs []job
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		persisted, err := lockCursor(ctx, tx, CursorName)
		if err != nil {
			return err
		}
		if !s.loaded || persisted != s.low {
			s.low, s.high, s.pending, s.loaded = persisted, persisted, map[int64]time.Time{}, true
		}
		rows, err := s.chat.ReadOutbox(ctx, s.high, passBatch)
		if err != nil {
			return err
		}
		read = len(rows)
		gaps := make([]int64, 0, len(s.pending))
		for id := range s.pending {
			gaps = append(gaps, id)
		}
		late, err := s.chat.ReadOutboxIDs(ctx, gaps)
		if err != nil {
			return err
		}
		now := s.now()
		for _, r := range rows {
			if r.ID-s.high <= maxGap {
				for gap := s.high + 1; gap < r.ID; gap++ {
					s.pending[gap] = now
				}
			}
			s.high = r.ID
			delete(s.pending, r.ID)
		}
		for _, r := range late {
			delete(s.pending, r.ID)
		}
		// PushMessages keeps the new messages among the rows.
		all := slices.DeleteFunc(append(late, rows...), func(r chat.OutboxRow) bool { return now.Sub(r.CreatedAt) > staleAfter })
		slices.SortFunc(all, func(a, b chat.OutboxRow) int { return cmp.Compare(a.ID, b.ID) })
		if jobs, err = s.plan(ctx, all, now); err != nil {
			return err
		}
		low := s.high
		for id, first := range s.pending {
			if now.Sub(first) > gapTTL {
				delete(s.pending, id)
				continue
			}
			low = min(low, id-1)
		}
		if low != persisted {
			if _, err := tx.Exec(ctx, `UPDATE outbox_cursors SET last_id = $2, updated_at = now() WHERE consumer = $1`,
				CursorName, low); err != nil {
				return fmt.Errorf("push: save cursor: %w", err)
			}
		}
		s.low = low
		return nil
	})
	if err != nil {
		// The in-memory cursor moved with the rolled-back transaction:
		// reload it; the rows are planned again.
		s.loaded = false
		return 0, err
	}
	for _, j := range jobs {
		s.queue.add(j)
	}
	return read, nil
}

// lockCursor returns the persisted cursor name under its row lock, creating it
// at the outbox head when missing.
func lockCursor(ctx context.Context, tx pgx.Tx, name string) (int64, error) {
	if _, err := tx.Exec(ctx, `
		INSERT INTO outbox_cursors (consumer, last_id) SELECT $1, coalesce(max(id), 0) FROM outbox
		ON CONFLICT (consumer) DO NOTHING`, name); err != nil {
		return 0, fmt.Errorf("push: create cursor: %w", err)
	}
	var last int64
	if err := tx.QueryRow(ctx, `SELECT last_id FROM outbox_cursors WHERE consumer = $1 FOR UPDATE`, name).Scan(&last); err != nil {
		return 0, fmt.Errorf("push: lock cursor: %w", err)
	}
	return last, nil
}

// plan turns new message rows into sends: one per subscription and chat
// (the newest message of the chat in this batch; the device shows one
// notification per chat anyway), skipping users who have the app in the
// foreground right now.
func (s *Service) plan(ctx context.Context, rows []chat.OutboxRow, now time.Time) ([]job, error) {
	if len(rows) == 0 {
		return nil, nil
	}
	msgs, err := s.chat.PushMessages(ctx, rows)
	if err != nil {
		return nil, err
	}
	type key struct{ sub, chat int64 }
	planned := map[key]int{}
	var jobs []job
	online := map[int64]bool{}
	for _, m := range msgs {
		targets, err := s.chat.PushTargets(ctx, m, s.cfg.SessionIdleTimeout, s.cfg.SessionMaxAge, now)
		if err != nil {
			return nil, err
		}
		for _, t := range targets {
			busy, seen := online[t.UserID]
			if !seen {
				busy = s.presence.Online(t.UserID)
				online[t.UserID] = busy
			}
			if busy {
				continue
			}
			j := job{target: t, notification: s.notification(m, t)}
			k := key{t.SubscriptionID, m.ChatID}
			if i, ok := planned[k]; ok {
				jobs[i] = j
				continue
			}
			planned[k] = len(jobs)
			jobs = append(jobs, j)
		}
	}
	return jobs, nil
}
