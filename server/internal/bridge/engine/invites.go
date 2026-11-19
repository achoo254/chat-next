package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/feature"
	"github.com/jackc/pgx/v5"
)

// InviteView is an invite link of a group in the other app (not a Chat invite link).
type InviteView struct {
	Link    string
	Title   string
	Revoked bool
	Usage   int
}

// Invites lists the links the account made for a synced group, as the other app last said.
func (e *Engine) Invites(ctx context.Context, owner, accountID int64, conversationID string) ([]InviteView, error) {
	if _, err := e.ownedAccount(ctx, owner, accountID); err != nil {
		return nil, err
	}
	rows, err := e.db.pool.Query(ctx, `
		SELECT link, title, revoked, usage FROM external_invites WHERE account_id = $1 AND external_chat_id = $2 ORDER BY revoked, seen_at DESC, link`,
		accountID, conversationID)
	if err != nil {
		return nil, fmt.Errorf("bridge: list invites: %w", err)
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (InviteView, error) {
		var v InviteView
		err := r.Scan(&v.Link, &v.Title, &v.Revoked, &v.Usage)
		return v, err
	})
}

// CreateInvite asks the other app for a new link for the group. It appears in Invites
// once the other app has made it.
func (e *Engine) CreateInvite(ctx context.Context, owner, accountID int64, conversationID, title string) error {
	return e.queueAction(ctx, owner, accountID, conversationID, feature.Invites, "invite_create", map[string]any{"title": title})
}

// RevokeInvite stops a link of the group from working.
func (e *Engine) RevokeInvite(ctx context.Context, owner, accountID int64, conversationID, link string) error {
	return e.queueAction(ctx, owner, accountID, conversationID, feature.Invites, "invite_revoke", map[string]any{"link": link})
}

// pollInvites reads the links of the synced groups. Chat holds them only to show them: the
// other app is the source, unless an action on a link waits to go out.
func (r *runner) pollInvites(ctx context.Context) error {
	mgr, ok := r.adapter.(bridge.InviteManager)
	if !ok || !bridge.FeaturesOf(r.adapter)[feature.Invites].In {
		return nil
	}
	r.invitesTick++
	if (r.invitesTick-1)%infoEvery != 0 {
		return nil
	}
	for conv, l := range r.links {
		if !l.BackfillDone {
			continue
		}
		dir, err := r.e.db.featureDirection(ctx, r.account.ID, l.ExternalChat, feature.Invites)
		if err != nil {
			return err
		}
		if !dir.Receives() {
			continue
		}
		if pending, err := r.e.db.pendingAny(ctx, l.ChatID, []string{"invite_create", "invite_revoke"}); err != nil {
			return err
		} else if pending {
			continue
		}
		links, err := retryRateLimit(ctx, func() ([]bridge.InviteLink, error) { return mgr.ListInvites(ctx, r.acct, conv) })
		if err != nil {
			if err := r.skipRefused(err, "invites", conv); err != nil {
				return err
			}
			continue
		}
		if err := r.storeInvites(ctx, l.ExternalChat, links); err != nil {
			return err
		}
	}
	return nil
}

func (r *runner) storeInvites(ctx context.Context, conv string, links []bridge.InviteLink) error {
	return pgx.BeginFunc(ctx, r.e.db.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `DELETE FROM external_invites WHERE account_id = $1 AND external_chat_id = $2`, r.account.ID, conv); err != nil {
			return fmt.Errorf("bridge: clear invites: %w", err)
		}
		for _, l := range links {
			if _, err := tx.Exec(ctx, `
				INSERT INTO external_invites (account_id, external_chat_id, link, title, revoked, usage) VALUES ($1, $2, $3, $4, $5, $6)
				ON CONFLICT DO NOTHING`, r.account.ID, conv, l.Link, l.Title, l.Revoked, l.Usage); err != nil {
				return fmt.Errorf("bridge: store invite: %w", err)
			}
		}
		return nil
	})
}

// doInviteOp makes or revokes an invite link.
func (r *runner) doInviteOp(ctx context.Context, h *outboxRow) error {
	mgr, ok := r.adapter.(bridge.InviteManager)
	if !ok {
		return r.e.db.setOutbox(ctx, []int64{h.ID}, "failed", "invites_unsupported: this app cannot take this from Chat", time.Time{})
	}
	var p struct {
		Title string `json:"title"`
		Link  string `json:"link"`
	}
	if err := json.Unmarshal(h.Payload, &p); err != nil {
		return r.e.db.setOutbox(ctx, []int64{h.ID}, "failed", "bad payload", time.Time{})
	}
	switch h.Op {
	case "invite_create":
		return r.guarded(ctx, h, "new link", func() error {
			link, err := mgr.CreateInvite(ctx, r.acct, h.ExternalChat, p.Title)
			if err != nil {
				return err
			}
			_, err = r.e.db.pool.Exec(ctx, `
				INSERT INTO external_invites (account_id, external_chat_id, link, title, revoked, usage) VALUES ($1, $2, $3, $4, false, 0)
				ON CONFLICT (account_id, external_chat_id, link) DO NOTHING`, r.account.ID, h.ExternalChat, link.Link, link.Title)
			return err
		}, nil)
	}
	return r.guarded(ctx, h, "link", func() error { return mgr.RevokeInvite(ctx, r.acct, h.ExternalChat, p.Link) }, func() error {
		_, err := r.e.db.pool.Exec(ctx, `UPDATE external_invites SET revoked = true WHERE account_id = $1 AND external_chat_id = $2 AND link = $3`, r.account.ID, h.ExternalChat, p.Link)
		return err
	})
}
