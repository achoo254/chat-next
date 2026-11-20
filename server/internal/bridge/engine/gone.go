package engine

import (
	"context"
	"fmt"
	"sort"
	"time"

	"app.local/server/internal/bridge"
	"app.local/server/internal/chat"
)

// goneBudget is how many unlisted conversations one listing asks the other app about.
var goneBudget = 20

// keepRefs stores the handle each listed conversation can be asked about by later, once
// it is no longer listed. Only the ones that changed are written.
func (r *runner) keepRefs(ctx context.Context, list []bridge.Conversation) error {
	var ids, refs []string
	for _, c := range list {
		if c.Ref != "" && r.links[c.ID] != nil {
			ids, refs = append(ids, c.ID), append(refs, c.Ref)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	if _, err := r.e.db.pool.Exec(ctx, `
		UPDATE external_chats x SET peer_ref = v.ref
		FROM unnest($2::text[], $3::text[]) AS v(id, ref)
		WHERE x.account_id = $1 AND x.external_chat_id = v.id AND x.peer_ref IS DISTINCT FROM v.ref`,
		r.account.ID, ids, refs); err != nil {
		return fmt.Errorf("bridge: keep conversation refs: %w", err)
	}
	return nil
}

// dropGone looks at the two-way chats whose conversation is no longer listed and asks
// the other app about each, at most goneBudget a listing. One the other app says the account is out of (deleted,
// removed, left) keeps its copy in Chat as a read-only record, as when the account
// leaves from Chat; it is not asked about again. One merely missing from the list
// stays as it is.
func (r *runner) dropGone(ctx context.Context, list []bridge.Conversation) error {
	checker, ok := r.adapter.(bridge.GoneChecker)
	if !ok {
		return nil
	}
	listed := make(map[string]bool, len(list))
	for _, c := range list {
		listed[c.ID] = true
	}
	var missing []string
	for conv, l := range r.links {
		if !listed[conv] && l.Direction == chat.DirectionBoth && !r.stillRefused("gone", conv) {
			missing = append(missing, conv)
		}
	}
	sort.Strings(missing)
	if len(missing) > goneBudget {
		missing = missing[:goneBudget]
	}
	for _, conv := range missing {
		l := r.links[conv]
		var ref string
		if err := r.e.db.pool.QueryRow(ctx, `SELECT coalesce(peer_ref, '') FROM external_chats WHERE id = $1`, l.ID).Scan(&ref); err != nil {
			return fmt.Errorf("bridge: conversation ref: %w", err)
		}
		gone, err := retryRateLimit(ctx, func() (bool, error) { return checker.ConversationGone(ctx, r.acct, conv, ref) })
		if err := r.skipRefused(err, "gone", conv); err != nil {
			return err
		}
		if !gone {
			// Asked again only after a while: a conversation missing from the list for
			// another reason (archived, a private chat cleared) would take every turn.
			r.refusedUntil["gone|"+conv] = time.Now().Add(refusedPause)
			continue
		}
		if err := r.e.chat.SetImportedDirection(ctx, r.account.OwnerID, l.ChatID, chat.DirectionIn); err != nil {
			return err
		}
		delete(r.links, conv)
		r.logger.Info("the conversation is gone from the other app; its copy in Chat is kept read-only", "conversation", conv, "chat_id", l.ChatID)
	}
	return nil
}
