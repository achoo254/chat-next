package engine

import (
	"context"
	"errors"
	"fmt"

	"app.local/server/internal/bridge"
	"app.local/server/internal/chat"
	"github.com/jackc/pgx/v5"
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
	// The runner is read under the lock: a handle is registered before its runner exists, and an
	// account that is still connecting reads its switch from the row when it does.
	e.mu.Lock()
	var r *runner
	if h := e.runners[a.ID]; h != nil {
		r = h.r
	}
	e.mu.Unlock()
	if r != nil {
		select {
		case r.syncNow <- struct{}{}:
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
	if err := r.forgetDeleted(ctx); err != nil {
		return err
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
	if err := r.keepRefs(ctx, list); err != nil {
		return err
	}
	if err := r.raiseListed(ctx, list); err != nil {
		return err
	}
	if err := r.dropGone(ctx, list); err != nil {
		return err
	}
	return r.settleSyncState(ctx)
}

// raiseListed makes two-way the read-only chats of the conversations the app lists now,
// for an app Chat can write to: a connected account syncs both ways (ADR 0024). A chat
// left read-only by a disconnect the owner signed in again after, or by a conversation
// that was gone or left and is back, is raised here; one whose conversation is not
// listed stays as it is, and a two-way chat is never lowered here. Each change goes
// through the chat service, which tells the owner's open sessions.
//
// An app that cannot say whether a conversation is gone (no bridge.GoneChecker: Zalo,
// whose list holds only the conversations heard since the server started) never lowers
// a chat for that reason, so for it a read-only chat is raised listed or not: only a
// disconnect, which signing in again undoes, or a copy made read-only before chats
// were two-way by default leaves one. Waiting for the list would keep such a chat
// read-only until its next message, and every restart forgets the list.
func (r *runner) raiseListed(ctx context.Context, list []bridge.Conversation) error {
	if !r.e.canSend(r.account.Source) {
		return nil
	}
	_, knowsGone := r.adapter.(bridge.GoneChecker)
	listed := make(map[string]bool, len(list))
	for _, c := range list {
		listed[c.ID] = true
	}
	// The stored direction decides, not the runner's copy: a chat may have been lowered
	// since the runner loaded its links.
	links, err := r.e.db.links(ctx, r.account.ID)
	if err != nil {
		return err
	}
	for _, l := range links {
		if l.Direction != chat.DirectionIn || (knowsGone && !listed[l.ExternalChat]) {
			continue
		}
		if err := r.e.chat.SetImportedDirection(ctx, r.account.OwnerID, l.ChatID, chat.DirectionBoth); err != nil {
			return err
		}
		// The runner's own copy follows (the look for conversations gone from the app
		// asks only about two-way ones).
		if have := r.links[l.ExternalChat]; have != nil {
			have.Direction = chat.DirectionBoth
		}
	}
	return nil
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
		if err := r.importOne(ctx, l); err != nil {
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

// importOne runs the first import of a chat. One the other app refuses (a peer it no
// longer knows, no right to read) keeps what it has and stops being waited for.
func (r *runner) importOne(ctx context.Context, l *chatLink) error {
	err := r.backfill(ctx, l)
	var limit *bridge.RateLimitError
	if errors.As(err, &limit) {
		// A long wait is not slept in the loop. The chat is first in line when the wait ends;
		// the pages of history already read are kept (keepWindow) and what an earlier batch
		// imported is skipped, so the next try goes on from where this one stopped.
		r.holdFlood(limit, "import")
		r.pending = append([]*chatLink{l}, r.pending...)
		return nil
	}
	if err == nil || !refused(err) {
		return err
	}
	r.logger.Warn("the first import of a conversation was refused; it is left as it is", "conversation", l.ExternalChat, "reason", err.Error())
	if err := r.e.db.finishBackfill(ctx, l.ID, ""); err != nil {
		return err
	}
	l.BackfillDone = true
	return nil
}

// forgetDeleted lets go of the conversations whose copy was deleted in Chat. Their link and the keys of
// their messages go, as when a copy is deleted through the bridge: a conversation still listed then gets a
// new copy at the listing; one that is gone from the other app is not read any more, instead of being
// asked about forever (the other app refuses it, which used to stop the whole account's sync).
func (r *runner) forgetDeleted(ctx context.Context) error {
	rows, err := r.e.db.pool.Query(ctx, `
		SELECT x.external_chat_id, x.chat_id FROM external_chats x JOIN chats c ON c.id = x.chat_id
		WHERE x.account_id = $1 AND c.deleted_at IS NOT NULL`, r.account.ID)
	if err != nil {
		return fmt.Errorf("bridge: list deleted copies: %w", err)
	}
	type gone struct {
		conv   string
		chatID int64
	}
	list, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (gone, error) {
		var g gone
		return g, row.Scan(&g.conv, &g.chatID)
	})
	if err != nil {
		return fmt.Errorf("bridge: list deleted copies: %w", err)
	}
	for _, g := range list {
		delete(r.links, g.conv)
		if err := r.e.chat.DeleteImportedChat(ctx, r.account.OwnerID, g.chatID); err != nil {
			return err
		}
		r.logger.Info("the copy of a conversation was deleted in Chat; its link is let go", "conversation", g.conv, "chat_id", g.chatID)
	}
	return nil
}
