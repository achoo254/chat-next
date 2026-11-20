package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/feature"
	"app.local/server/internal/chat"
)

// memberActionOps are the outbox ops that act on people in the other app.
var memberActionOps = []string{"member_remove", "member_admin", "member_add", "member_perms"}

// pendingAny says whether the chat has a row of one of ops waiting or on its way.
func (d *db) pendingAny(ctx context.Context, chatID int64, ops []string) (bool, error) {
	var n int
	if err := d.pool.QueryRow(ctx, `SELECT count(*) FROM external_outbox WHERE chat_id = $1 AND op = ANY($2) AND status IN ('pending', 'sending')`, chatID, ops).Scan(&n); err != nil {
		return false, fmt.Errorf("bridge: pending ops: %w", err)
	}
	return n > 0, nil
}

// audit records what was done to people in the other app and how it ended.
func (d *db) audit(ctx context.Context, h *outboxRow, accountID, actor int64, action, target, result, detail string) error {
	if len(detail) > 500 {
		detail = detail[:500]
	}
	if _, err := d.pool.Exec(ctx, `
		INSERT INTO external_audit (account_id, external_chat_id, chat_id, feature, action, target, actor_id, result, detail)
		VALUES ($1, $2, $3, $9, $4, $5, $6, $7, $8)`, accountID, h.ExternalChat, h.ChatID, action, target, actor, result, detail, featureOfOp(h.Op)); err != nil {
		return fmt.Errorf("bridge: audit: %w", err)
	}
	return nil
}

// sentThisHour counts the actions on people the account has sent in the last hour.
func (d *db) sentThisHour(ctx context.Context, accountID int64) (int, error) {
	var n int
	if err := d.pool.QueryRow(ctx, `
		SELECT count(*) FROM external_audit WHERE account_id = $1 AND result = 'sent' AND created_at > now() - interval '1 hour'`,
		accountID).Scan(&n); err != nil {
		return 0, fmt.Errorf("bridge: count member actions: %w", err)
	}
	return n, nil
}

// pollMembers reads who is in the synced groups and makes the puppets in Chat match.
// The other app is the source unless Chat has an action on a member waiting to go
// out, so what Chat just did is not undone before it is sent, and what the other app
// refused is put back.
func (r *runner) pollMembers(ctx context.Context) error {
	reader, ok := r.adapter.(bridge.MemberReader)
	if !ok || !bridge.FeaturesOf(r.adapter)[feature.Members].In {
		return nil
	}
	r.membersTick++
	if (r.membersTick-1)%infoEvery != 0 {
		return nil
	}
	for conv, l := range r.links {
		if !l.BackfillDone {
			continue
		}
		dir, err := r.e.db.featureDirection(ctx, r.account.ID, l.ExternalChat, feature.Members)
		if err != nil {
			return err
		}
		if !dir.Receives() {
			continue
		}
		if r.stillRefused("members", conv) {
			continue
		}
		if pending, err := r.e.db.pendingAny(ctx, l.ChatID, memberActionOps); err != nil {
			return err
		} else if pending {
			continue
		}
		list, complete, err := retryRateLimit2(ctx, func() ([]bridge.Member, bool, error) { return reader.ListMembers(ctx, r.acct, conv) })
		if err != nil {
			if err := r.skipRefused(err, "members", conv); err != nil {
				return err
			}
			continue
		}
		var members []chat.ImportedMember
		for _, m := range list {
			if m.Participant.IsSelf {
				continue
			}
			id, err := r.e.db.ensurePuppet(ctx, r.account, m.Participant)
			if err != nil {
				return err
			}
			im := chat.ImportedMember{UserID: id, Admin: m.Admin}
			if m.Perms != nil {
				bits := bitsOfPerms(*m.Perms)
				im.Perms = &bits
			}
			members = append(members, im)
		}
		if err := r.withLink(ctx, l, func(it *chat.ImportTx) error {
			_, err := it.SyncMembers(ctx, members, complete)
			return err
		}); err != nil {
			return err
		}
	}
	return nil
}

// doMemberAction sends an action on a person: removing them, adding them, making them an
// admin, restricting them.
func (r *runner) doMemberAction(ctx context.Context, h *outboxRow) error {
	writer, ok := r.adapter.(bridge.MemberWriter)
	if !ok {
		return r.e.db.setOutbox(ctx, []int64{h.ID}, "failed", "members_unsupported: this app cannot take this from Chat", time.Time{})
	}
	var p struct {
		Participant string `json:"participant"`
		Admin       bool   `json:"admin"`
		Perms       uint32 `json:"perms"`
	}
	if err := json.Unmarshal(h.Payload, &p); err != nil || p.Participant == "" {
		return r.e.db.setOutbox(ctx, []int64{h.ID}, "failed", "bad payload", time.Time{})
	}
	return r.guarded(ctx, h, p.Participant, func() error {
		switch h.Op {
		case "member_remove":
			return writer.RemoveMember(ctx, r.acct, h.ExternalChat, p.Participant)
		case "member_admin":
			return writer.SetMemberAdmin(ctx, r.acct, h.ExternalChat, p.Participant, p.Admin)
		case "member_add":
			if adder, ok := r.adapter.(bridge.MemberAdder); ok {
				return adder.AddMember(ctx, r.acct, h.ExternalChat, p.Participant)
			}
		case "member_perms":
			if pw, ok := r.adapter.(bridge.PermWriter); ok {
				return pw.SetMemberPerms(ctx, r.acct, h.ExternalChat, p.Participant, permsOfBits(p.Perms))
			}
		}
		return fmt.Errorf("%w: this app cannot do that from Chat", bridge.ErrNotAllowed)
	}, nil)
}

// guarded is the one place Chat acts on people and groups in the other app: it checks the
// limit per hour, writes the audit row whatever happens, and when the other app refuses
// has Chat read the members again at once. after runs once the call went through.
func (r *runner) guarded(ctx context.Context, h *outboxRow, target string, call func() error, after func() error) error {
	db := r.e.db
	owner := r.account.OwnerID
	if n, err := db.sentThisHour(ctx, r.account.ID); err != nil {
		return err
	} else if n >= r.e.cfg.MemberActionsPerHour {
		if err := db.audit(ctx, h, r.account.ID, owner, h.Op, target, "limited", "hourly limit of actions on people reached"); err != nil {
			return err
		}
		r.membersTick = 0
		return db.setOutbox(ctx, []int64{h.ID}, "failed", "limit: too many actions on people in an hour", time.Time{})
	}
	if err := db.audit(ctx, h, r.account.ID, owner, h.Op, target, "started", ""); err != nil {
		return err // logged before it is sent: no log, no action
	}
	if err := db.startSending(ctx, []int64{h.ID}); err != nil {
		return err
	}
	if err := call(); err != nil {
		if aerr := db.audit(ctx, h, r.account.ID, owner, h.Op, target, "failed", err.Error()); aerr != nil {
			return aerr
		}
		if serr := r.settleCall(ctx, []*outboxRow{h}, err); serr != nil {
			return serr
		}
		var status string
		if qerr := db.pool.QueryRow(ctx, `SELECT status FROM external_outbox WHERE id = $1`, h.ID).Scan(&status); qerr != nil {
			return qerr
		}
		if status == "failed" {
			r.membersTick = 0 // the next look puts Chat back to who the other app has
		}
		return nil
	}
	if err := db.audit(ctx, h, r.account.ID, owner, h.Op, target, "sent", ""); err != nil {
		return err
	}
	if after != nil {
		if err := after(); err != nil {
			return err
		}
	}
	return db.setOutbox(ctx, []int64{h.ID}, "sent", "", time.Time{})
}

// retryRateLimit2 is retryRateLimit for a call that answers a list and a flag.
func retryRateLimit2[A any, B any](ctx context.Context, call func() (A, B, error)) (A, B, error) {
	var b B
	a, err := retryRateLimit(ctx, func() (A, error) {
		x, y, err := call()
		b = y
		return x, err
	})
	return a, b, err
}
