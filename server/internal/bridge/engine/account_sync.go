package engine

import (
	"context"
	"errors"
	"fmt"

	"app.local/server/internal/bridge"
	"app.local/server/internal/chat"
)

// The states of an account's one switch (ADR 0024).
const (
	SyncOff     = "off"
	SyncSyncing = "syncing"
	SyncLive    = "live"
)

// conversationsEvery: the conversations of the app are listed again once in this many
// looks at the state of the chats, for one that appeared without a message yet.
const conversationsEvery = 5

// StartSync turns the account's switch on: every conversation of the app gets a chat,
// imported newest first, and the ones that appear later join on their own. Turning it
// on again does nothing.
func (e *Engine) StartSync(ctx context.Context, owner, accountID int64) error {
	a, err := e.ownedAccount(ctx, owner, accountID)
	if err != nil {
		return err
	}
	if a.Status == "stopped" {
		return ErrNotFound
	}
	if _, err := e.db.pool.Exec(ctx, `UPDATE external_accounts SET sync_state = $2, updated_at = now() WHERE id = $1 AND sync_state = $3`,
		a.ID, SyncSyncing, SyncOff); err != nil {
		return fmt.Errorf("bridge: start sync: %w", err)
	}
	e.mu.Lock()
	h := e.runners[a.ID]
	e.mu.Unlock()
	if h != nil {
		select {
		case h.r.syncNow <- struct{}{}:
		default: // already asked
		}
	}
	return nil
}

func (r *runner) syncOn() bool {
	return r.account.SyncState == SyncSyncing || r.account.SyncState == SyncLive
}

// reloadSyncState reads the account's switch again (StartSync changed it).
func (r *runner) reloadSyncState(ctx context.Context) error {
	return r.e.db.pool.QueryRow(ctx, `SELECT sync_state FROM external_accounts WHERE id = $1`, r.account.ID).Scan(&r.account.SyncState)
}

// syncConversations gives a chat to every conversation of the app that has none yet,
// in the app's order (the most recently active first), and queues its import.
func (r *runner) syncConversations(ctx context.Context) error {
	if !r.syncOn() {
		return nil
	}
	list, err := retryRateLimit(ctx, func() ([]bridge.Conversation, error) { return r.adapter.ListConversations(ctx, r.acct) })
	if err != nil {
		return err
	}
	for _, c := range list {
		if r.links[c.ID] != nil {
			continue
		}
		if _, err := r.e.linkConversation(ctx, r.account.ID, c, DefaultWindow, chat.DirectionBoth); err != nil {
			if errors.Is(err, context.Canceled) {
				return err
			}
			// One conversation Chat cannot copy (an unknown kind, no other side) is left
			// out; the others go on.
			r.logger.Warn("a conversation was not synced", "conversation", c.ID, "reason", err.Error())
			continue
		}
		l, err := r.e.db.link(ctx, r.account.ID, c.ID)
		if err != nil {
			return err
		}
		if l == nil {
			continue
		}
		r.links[c.ID] = l
		r.pending = append(r.pending, l)
	}
	return r.settleSyncState(ctx)
}

// importNext imports the next conversation waiting for its first import. One at a
// time, between events: what arrives meanwhile waits at most one import.
func (r *runner) importNext(ctx context.Context) error {
	for len(r.pending) > 0 {
		l := r.pending[0]
		r.pending = r.pending[1:]
		if l.BackfillDone || r.links[l.ExternalChat] != l {
			continue
		}
		if err := r.backfill(ctx, l); err != nil {
			return err
		}
		break
	}
	return r.settleSyncState(ctx)
}

// settleSyncState moves a syncing account to live once every chat is imported.
func (r *runner) settleSyncState(ctx context.Context) error {
	if r.account.SyncState != SyncSyncing || len(r.pending) > 0 {
		return nil
	}
	for _, l := range r.links {
		if !l.BackfillDone {
			return nil
		}
	}
	if _, err := r.e.db.pool.Exec(ctx, `UPDATE external_accounts SET sync_state = $2, updated_at = now() WHERE id = $1 AND sync_state = $3`,
		r.account.ID, SyncLive, SyncSyncing); err != nil {
		return fmt.Errorf("bridge: sync live: %w", err)
	}
	r.account.SyncState = SyncLive
	return nil
}

// syncProgress counts how far the first import of an account's chats went.
func (d *db) syncProgress(ctx context.Context, accountID int64) (SyncProgress, error) {
	var p SyncProgress
	err := d.pool.QueryRow(ctx, `
		SELECT count(*), count(*) FILTER (WHERE x.backfill_done), coalesce(sum(m.n), 0),
			coalesce(sum(CASE WHEN x.backfill_done THEN m.n ELSE greatest(x.history_window, m.n) END), 0)
		FROM external_chats x
		LEFT JOIN LATERAL (SELECT count(*) AS n FROM external_messages e WHERE e.account_id = x.account_id AND e.external_chat_id = x.external_chat_id) m ON true
		WHERE x.account_id = $1`, accountID).Scan(&p.Conversations, &p.Done, &p.Messages, &p.Expected)
	if err != nil {
		return p, fmt.Errorf("bridge: sync progress: %w", err)
	}
	return p, nil
}
