package engine

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/feature"
	"app.local/server/internal/chat"
	"github.com/jackc/pgx/v5"
)

var (
	// ErrFeatureOff is returned when the action belongs to a feature that is not turned on to send for the chat.
	ErrFeatureOff = errors.New("bridge: this is not turned on for the chat")
	// ErrConfirmation is returned when the name or the token that confirms a final action is wrong or not valid yet.
	ErrConfirmation = errors.New("bridge: the confirmation is not right")
)

const (
	// deleteConfirmFor is how long it stays valid.
	deleteConfirmFor = 5 * time.Minute
)

// queueAction queues op for the group of the account's chat, if the feature is supported
// by the app and turned on to send for that chat. The row replaces nothing: each action
// is its own row.
func (e *Engine) queueAction(ctx context.Context, owner, accountID int64, conversationID string, feat feature.Feature, op string, payload map[string]any) error {
	a, err := e.ownedAccount(ctx, owner, accountID)
	if err != nil {
		return err
	}
	l, err := e.db.link(ctx, accountID, conversationID)
	if err != nil {
		return err
	}
	if l == nil {
		return ErrNotFound
	}
	adapter := e.adapters[a.Source]
	if adapter == nil || !bridge.FeaturesOf(adapter)[feat].Out {
		return ErrFeatureUnsupported
	}
	if a.Status == "stopped" {
		return ErrSendUnsupported
	}
	dir, err := e.db.featureDirection(ctx, accountID, conversationID, feat)
	if err != nil {
		return err
	}
	if !dir.Sends() {
		return ErrFeatureOff
	}
	return e.insertAction(ctx, accountID, l, feat, op, payload)
}

func (e *Engine) insertAction(ctx context.Context, accountID int64, l *chatLink, feat feature.Feature, op string, payload map[string]any) error {
	body, err := jsonBytes(payload)
	if err != nil {
		return err
	}
	if _, err := e.db.pool.Exec(ctx, `
		INSERT INTO external_outbox (account_id, external_chat_id, chat_id, seq, op, feature, payload)
		VALUES ($1, $2, $3, (extract(epoch from clock_timestamp()) * 1000000)::bigint, $4, $5, $6)`,
		accountID, l.ExternalChat, l.ChatID, op, string(feat), body); err != nil {
		return fmt.Errorf("bridge: queue %s: %w", op, err)
	}
	return nil
}

// Candidate is a person of the other app that is not in the group yet and can be added.
type Candidate struct {
	ParticipantID string
	Name          string
}

// Candidates lists the people of the account (the ones the other app has shown to it)
// who are not members of the chat, to pick who to add.
func (e *Engine) Candidates(ctx context.Context, owner, accountID int64, conversationID string) ([]Candidate, error) {
	if _, err := e.ownedAccount(ctx, owner, accountID); err != nil {
		return nil, err
	}
	l, err := e.db.link(ctx, accountID, conversationID)
	if err != nil {
		return nil, err
	}
	if l == nil {
		return nil, ErrNotFound
	}
	rows, err := e.db.pool.Query(ctx, `
		SELECT x.external_user_id, u.name FROM external_users x JOIN users u ON u.id = x.user_id
		WHERE x.account_id = $1 AND x.external_user_id ~ '^[0-9]+$'
		AND NOT EXISTS (SELECT 1 FROM chat_members m WHERE m.chat_id = $2 AND m.user_id = x.user_id AND m.left_at IS NULL)
		ORDER BY u.name LIMIT 200`, accountID, l.ChatID)
	if err != nil {
		return nil, fmt.Errorf("bridge: candidates: %w", err)
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Candidate, error) {
		var c Candidate
		err := r.Scan(&c.ParticipantID, &c.Name)
		return c, err
	})
}

// AddMember asks the other app to add a person it knows to the group. The person joins Chat's
// copy when the other app lists them as a member.
func (e *Engine) AddMember(ctx context.Context, owner, accountID int64, conversationID, participant string) error {
	var known bool
	if err := e.db.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM external_users WHERE account_id = $1 AND external_user_id = $2)`, accountID, participant).Scan(&known); err != nil {
		return fmt.Errorf("bridge: known person: %w", err)
	}
	if !known {
		return ErrNotFound
	}
	return e.queueAction(ctx, owner, accountID, conversationID, feature.Members, "member_add", map[string]any{"participant": participant})
}

// confirmedName checks that name is the name of the chat, which is how the owner confirms
// an action that cannot be undone: it cannot be done by a click.
func (e *Engine) confirmedName(ctx context.Context, chatID int64, name string) error {
	var title string
	if err := e.db.pool.QueryRow(ctx, `SELECT title FROM chats WHERE id = $1`, chatID).Scan(&title); err != nil {
		return fmt.Errorf("bridge: chat title: %w", err)
	}
	if strings.TrimSpace(name) == "" || !strings.EqualFold(strings.TrimSpace(name), strings.TrimSpace(title)) {
		return ErrConfirmation
	}
	return nil
}

func (e *Engine) lifecycleLink(ctx context.Context, owner, accountID int64, conversationID string) (*chatLink, error) {
	if _, err := e.ownedAccount(ctx, owner, accountID); err != nil {
		return nil, err
	}
	l, err := e.db.link(ctx, accountID, conversationID)
	if err != nil {
		return nil, err
	}
	if l == nil {
		return nil, ErrNotFound
	}
	return l, nil
}

// LeaveGroup makes the account leave the group in the other app. confirmName must be the
// name of the chat. Afterwards the chat stays as a read-only copy.
func (e *Engine) LeaveGroup(ctx context.Context, owner, accountID int64, conversationID, confirmName string) error {
	l, err := e.lifecycleLink(ctx, owner, accountID, conversationID)
	if err != nil {
		return err
	}
	if err := e.confirmedName(ctx, l.ChatID, confirmName); err != nil {
		return err
	}
	return e.queueAction(ctx, owner, accountID, conversationID, feature.Lifecycle, "group_leave", map[string]any{})
}

// RequestGroupDelete is the first step of deleting a group in the other app: it gives a
// token that is good for DeleteGroup from Config.DeleteConfirmAfter until deleteConfirmFor later.
func (e *Engine) RequestGroupDelete(ctx context.Context, owner, accountID int64, conversationID, confirmName string) (token string, usableFrom, expires time.Time, err error) {
	l, err := e.lifecycleLink(ctx, owner, accountID, conversationID)
	if err != nil {
		return "", time.Time{}, time.Time{}, err
	}
	if err := e.confirmedName(ctx, l.ChatID, confirmName); err != nil {
		return "", time.Time{}, time.Time{}, err
	}
	dir, err := e.db.featureDirection(ctx, accountID, conversationID, feature.Lifecycle)
	if err != nil {
		return "", time.Time{}, time.Time{}, err
	}
	if !dir.Sends() {
		return "", time.Time{}, time.Time{}, ErrFeatureOff
	}
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", time.Time{}, time.Time{}, fmt.Errorf("bridge: token: %w", err)
	}
	token = hex.EncodeToString(raw[:])
	now := time.Now()
	if _, err := e.db.pool.Exec(ctx, `INSERT INTO external_confirmations (token, account_id, external_chat_id, action) VALUES ($1, $2, $3, 'group_delete')`, token, accountID, conversationID); err != nil {
		return "", time.Time{}, time.Time{}, fmt.Errorf("bridge: confirmation: %w", err)
	}
	return token, now.Add(e.cfg.DeleteConfirmAfter), now.Add(deleteConfirmFor), nil
}

// DeleteGroup deletes the group for everybody in the other app, history included. It needs the
// name of the chat and the token of RequestGroupDelete, used no sooner than deleteConfirmAfter
// after it was made and no later than deleteConfirmFor, and once.
func (e *Engine) DeleteGroup(ctx context.Context, owner, accountID int64, conversationID, confirmName, token string) error {
	l, err := e.lifecycleLink(ctx, owner, accountID, conversationID)
	if err != nil {
		return err
	}
	if err := e.confirmedName(ctx, l.ChatID, confirmName); err != nil {
		return err
	}
	tag, err := e.db.pool.Exec(ctx, `
		UPDATE external_confirmations SET used_at = now()
		WHERE token = $1 AND account_id = $2 AND external_chat_id = $3 AND action = 'group_delete' AND used_at IS NULL
			AND created_at <= now() - make_interval(secs => $4) AND created_at > now() - make_interval(secs => $5)`,
		token, accountID, conversationID, e.cfg.DeleteConfirmAfter.Seconds(), deleteConfirmFor.Seconds())
	if err != nil {
		return fmt.Errorf("bridge: confirmation: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrConfirmation
	}
	return e.queueAction(ctx, owner, accountID, conversationID, feature.Lifecycle, "group_delete", map[string]any{})
}

// doGroupAction leaves or deletes a group. The delete is limited to one an hour for the
// account and logged before it is sent. Afterwards the chat is a read-only copy: nothing
// more goes to a group that is gone.
func (r *runner) doGroupAction(ctx context.Context, h *outboxRow) error {
	lc, ok := r.adapter.(bridge.GroupLifecycle)
	if !ok {
		return r.e.db.setOutbox(ctx, []int64{h.ID}, "failed", "lifecycle_unsupported: this app cannot do this from Chat", time.Time{})
	}
	if h.Op == "group_delete" {
		var n int
		if err := r.e.db.pool.QueryRow(ctx, `SELECT count(*) FROM external_audit WHERE account_id = $1 AND action = 'group_delete' AND result = 'started' AND created_at > now() - interval '1 hour'`, r.account.ID).Scan(&n); err != nil {
			return err
		}
		if n >= 1 {
			if err := r.e.db.audit(ctx, h, r.account.ID, r.account.OwnerID, h.Op, "group", "limited", "one deletion an hour"); err != nil {
				return err
			}
			return r.e.db.setOutbox(ctx, []int64{h.ID}, "failed", "limit: one group deleted an hour", time.Time{})
		}
	}
	return r.guarded(ctx, h, "group", func() error {
		if h.Op == "group_delete" {
			return lc.DeleteGroup(ctx, r.acct, h.ExternalChat)
		}
		return lc.LeaveGroup(ctx, r.acct, h.ExternalChat)
	}, func() error {
		// The copy stays, as a read-only record.
		if err := r.e.chat.SetImportedDirection(ctx, r.account.OwnerID, h.ChatID, chat.DirectionIn); err != nil {
			return err
		}
		delete(r.links, h.ExternalChat)
		return nil
	})
}
