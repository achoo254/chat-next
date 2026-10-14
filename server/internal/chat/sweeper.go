package chat

import (
	"context"
	"fmt"
	"sync"
	"time"

	appv1 "app.local/server/gen/app/v1"
)

// The realtime consumer of the outbox (ADR 0003). The dispatcher delivers
// right after commit; the sweeper only picks up what it missed (a full
// queue) and the rows written outside this package's transactions, which
// today is session_revoked (a trigger on user_sessions). Its cursor lives in
// memory: sockets do not survive a restart, so a restarted process starts
// at the head of the log and clients catch up with GetDifference.
const (
	sweepInterval = 150 * time.Millisecond
	sweepBatch    = 500
	// sweepGrace leaves young rows to the dispatcher.
	sweepGrace = 300 * time.Millisecond
	// gapTTL: an id skipped by the cursor that has not appeared by then
	// belongs to a rolled-back transaction.
	gapTTL = 30 * time.Second
	maxGap = 10000
)

// deliveredTTL is how long a delivered outbox id is remembered after the
// sweeper's cursor passed it, so a dispatcher queue running that late
// still sees it was delivered.
const deliveredTTL = time.Minute

// idSet is a concurrent set of outbox ids with when each was added.
type idSet struct {
	mu  sync.Mutex
	ids map[int64]time.Time
}

func newIDSet() *idSet {
	return &idSet{ids: map[int64]time.Time{}}
}

// addIfAbsent adds id and reports whether it was absent: exactly one of
// the dispatcher and the sweeper wins the right to deliver an event.
func (s *idSet) addIfAbsent(id int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.ids[id]; ok {
		return false
	}
	s.ids[id] = time.Now()
	return true
}

func (s *idSet) has(id int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.ids[id]
	return ok
}

// prune forgets ids below floor that were added before cutoff.
func (s *idSet) prune(floor int64, cutoff time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, at := range s.ids {
		if id < floor && at.Before(cutoff) {
			delete(s.ids, id)
		}
	}
}

type outboxRow struct {
	ID        int64
	CreatedAt time.Time
	Kind      string
	ChatID    int64
	ActorID   int64
	SessionID int64
	Reason    int16
	UserIDs   []int64
	Pts       []int64
	ChatPts   []int64
}

type sweepState struct {
	cursor int64
	// pending: ids at or below the cursor that are not handled yet (gaps of
	// uncommitted transactions, young rows), with when they were first seen.
	pending map[int64]time.Time
}

// RunOutboxSweeper runs the realtime outbox consumer until ctx ends.
func (s *Service) RunOutboxSweeper(ctx context.Context) {
	st := &sweepState{pending: map[int64]time.Time{}}
	// Start at the head; never replay the whole log after a failed read.
	for {
		err := s.pool.QueryRow(ctx, `SELECT coalesce(max(id), 0) FROM outbox`).Scan(&st.cursor)
		if err == nil {
			break
		}
		if ctx.Err() != nil {
			return
		}
		s.logger.Error("outbox sweeper cannot read the log head; retrying", "err", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
	ticker := time.NewTicker(sweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := s.sweep(ctx, st); err != nil && ctx.Err() == nil {
				s.logger.Error("outbox sweep failed", "err", err)
			}
		}
	}
}

func (s *Service) sweep(ctx context.Context, st *sweepState) error {
	rows, err := s.readOutbox(ctx, `id > $1 ORDER BY id LIMIT `+fmt.Sprint(sweepBatch), st.cursor)
	if err != nil {
		return err
	}
	if len(st.pending) > 0 {
		ids := make([]int64, 0, len(st.pending))
		for id := range st.pending {
			ids = append(ids, id)
		}
		more, err := s.readOutbox(ctx, `id = ANY($1)`, ids)
		if err != nil {
			return err
		}
		rows = append(more, rows...)
	}
	now := time.Now()
	seen := map[int64]bool{}
	for _, r := range rows {
		seen[r.ID] = true
		if r.ID > st.cursor {
			// A jump wider than maxGap is a sequence reset, not open
			// transactions.
			if r.ID-st.cursor <= maxGap {
				for gap := st.cursor + 1; gap < r.ID; gap++ {
					if !seen[gap] {
						st.pending[gap] = now
					}
				}
			}
			st.cursor = r.ID
		}
		delete(st.pending, r.ID)
		if s.dispatch.delivered.has(r.ID) {
			continue
		}
		if r.Kind != kindSessionRevoked && now.Sub(r.CreatedAt) < sweepGrace {
			st.pending[r.ID] = now
			continue
		}
		if !s.dispatch.delivered.addIfAbsent(r.ID) {
			continue // the dispatcher got to it meanwhile
		}
		ev, err := s.rebuildEvent(ctx, r)
		if err != nil {
			return err
		}
		if err := s.deliver(ctx, ev); err != nil {
			return err
		}
	}
	floor := st.cursor + 1
	for id, first := range st.pending {
		if now.Sub(first) > gapTTL {
			delete(st.pending, id)
			continue
		}
		floor = min(floor, id)
	}
	s.dispatch.delivered.prune(floor, now.Add(-deliveredTTL))
	return nil
}

func (s *Service) readOutbox(ctx context.Context, where string, arg any) ([]outboxRow, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, created_at, kind, chat_id, actor_id, session_id, reason, user_ids, pts, chat_pts
		FROM outbox WHERE `+where, arg)
	if err != nil {
		return nil, fmt.Errorf("chat: read outbox: %w", err)
	}
	defer rows.Close()
	var out []outboxRow
	for rows.Next() {
		var r outboxRow
		if err := rows.Scan(&r.ID, &r.CreatedAt, &r.Kind, &r.ChatID, &r.ActorID, &r.SessionID, &r.Reason,
			&r.UserIDs, &r.Pts, &r.ChatPts); err != nil {
			return nil, fmt.Errorf("chat: read outbox: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("chat: read outbox: %w", err)
	}
	return out, nil
}

// rebuildEvent turns an outbox row back into an Event from the logs.
func (s *Service) rebuildEvent(ctx context.Context, r outboxRow) (*Event, error) {
	ev := &Event{OutboxID: r.ID, Kind: r.Kind, ChatID: r.ChatID, ActorID: r.ActorID}
	if r.Kind == kindSessionRevoked {
		ev.SessionID = r.SessionID
		ev.Reason = appv1.SessionRevokeReason(r.Reason)
		return ev, nil
	}
	if len(r.UserIDs) > 0 {
		rows, err := s.pool.Query(ctx, `
			SELECT u.user_id, u.pts, u."update" FROM user_updates u
			JOIN unnest($1::bigint[], $2::bigint[]) AS x(user_id, pts) ON x.user_id = u.user_id AND x.pts = u.pts
			ORDER BY u.pts`, r.UserIDs, r.Pts)
		if err != nil {
			return nil, fmt.Errorf("chat: replay user logs: %w", err)
		}
		for rows.Next() {
			var e userEntry
			var payload []byte
			if err := rows.Scan(&e.UserID, &e.Pts, &payload); err != nil {
				rows.Close()
				return nil, fmt.Errorf("chat: replay user logs: %w", err)
			}
			if e.Update, err = decodeStored(payload); err != nil {
				rows.Close()
				return nil, err
			}
			ev.Users = append(ev.Users, e)
			if mr, ok := e.Update.Kind.(*appv1.Update_MemberRemoved); ok && mr.MemberRemoved.GetUserId() == e.UserID {
				ev.Forget = append(ev.Forget, e.UserID)
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("chat: replay user logs: %w", err)
		}
	}
	if len(r.ChatPts) > 0 {
		rows, err := s.pool.Query(ctx, `
			SELECT chat_pts, "update" FROM chat_updates WHERE chat_id = $1 AND chat_pts = ANY($2) ORDER BY chat_pts`,
			r.ChatID, r.ChatPts)
		if err != nil {
			return nil, fmt.Errorf("chat: replay chat log: %w", err)
		}
		for rows.Next() {
			e := chatEntry{ChatID: r.ChatID}
			var payload []byte
			if err := rows.Scan(&e.ChatPts, &payload); err != nil {
				rows.Close()
				return nil, fmt.Errorf("chat: replay chat log: %w", err)
			}
			if e.Update, err = decodeStored(payload); err != nil {
				rows.Close()
				return nil, err
			}
			ev.Chats = append(ev.Chats, e)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("chat: replay chat log: %w", err)
		}
		if err := s.pool.QueryRow(ctx, `SELECT last_seq FROM chats WHERE id = $1`, r.ChatID).Scan(&ev.TopSeq); err != nil {
			return nil, fmt.Errorf("chat: replay top seq: %w", err)
		}
	}
	return ev, nil
}
