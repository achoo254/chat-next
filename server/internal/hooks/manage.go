package hooks

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/chat"
	"github.com/jackc/pgx/v5"
)

// audit appends an entry to hook_audit.
func (s *Service) audit(ctx context.Context, tx pgx.Tx, h *hookRow, actor int64, action, detail string) error {
	if _, err := tx.Exec(ctx, `
		INSERT INTO hook_audit (tenant_id, chat_id, hook_id, hook_name, actor_id, action, detail)
		VALUES ($1, $2, $3, $4, $5, $6, $7)`, s.cfg.TenantID, h.ChatID, h.ID, h.Name, actor, action, detail); err != nil {
		return fmt.Errorf("hooks: audit: %w", err)
	}
	return nil
}

// manage runs fn on the hook, locked, in a transaction that also holds the
// chat lock, when me is an admin of the hook's chat.
func (s *Service) manage(ctx context.Context, me int64, hookID string, fn func(it *chat.IntegrationTx, h *hookRow) error) (*hookRow, error) {
	h, err := s.loadHook(ctx, s.pool, hookID, false)
	if err != nil {
		return nil, err
	}
	if h == nil {
		return nil, errNotFound()
	}
	var out *hookRow
	err = s.chat.WithChatAdmin(ctx, h.ChatID, me, func(it *chat.IntegrationTx) error {
		locked, err := s.loadHook(ctx, it.Tx(), hookID, true)
		if err != nil {
			return err
		}
		if locked == nil {
			return errNotFound()
		}
		if err := fn(it, locked); err != nil {
			return err
		}
		out = locked
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// readable returns the hook when me is an admin of its chat.
func (s *Service) readable(ctx context.Context, me int64, hookID string) (*hookRow, error) {
	h, err := s.loadHook(ctx, s.pool, hookID, false)
	if err != nil {
		return nil, err
	}
	if h == nil {
		return nil, errNotFound()
	}
	if err := s.chat.CheckChatAdmin(ctx, h.ChatID, me); err != nil {
		return nil, err
	}
	return h, nil
}

// users renders the users a list of hooks or audit entries mentions.
func (s *Service) users(ctx context.Context, me int64, ids []int64) ([]*appv1.User, error) {
	slices.Sort(ids)
	ids = slices.Compact(ids)
	ids = slices.DeleteFunc(ids, func(id int64) bool { return id <= 0 })
	if len(ids) == 0 {
		return nil, nil
	}
	return s.chat.GetUsers(ctx, me, ids)
}

// CreateIncomingHook creates a hook in a group or channel me administers.
func (s *Service) CreateIncomingHook(ctx context.Context, me int64, req *appv1.CreateIncomingHookRequest) (*appv1.CreateIncomingHookResponse, error) {
	name, err := cleanName(req.GetName())
	if err != nil {
		return nil, err
	}
	kind, ok := formatOf[req.GetFormat()]
	if !ok {
		return nil, errInvalid("format is required")
	}
	if req.GetChatId() <= 0 {
		return nil, errInvalid("chat_id is required")
	}
	id, err := randomBase62(idLength)
	if err != nil {
		return nil, err
	}
	secret, hash, err := newSecret()
	if err != nil {
		return nil, err
	}
	var h *hookRow
	err = s.chat.WithChatAdmin(ctx, req.GetChatId(), me, func(it *chat.IntegrationTx) error {
		tx := it.Tx()
		var count int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM incoming_hooks WHERE chat_id = $1`, req.GetChatId()).Scan(&count); err != nil {
			return fmt.Errorf("hooks: count hooks: %w", err)
		}
		if count >= hooksPerChatMax {
			return errPrecondition("hooks_limit: a chat has at most %d webhooks", hooksPerChatMax)
		}
		row, err := scanHook(tx.QueryRow(ctx, `
			INSERT INTO incoming_hooks (id, tenant_id, chat_id, name, format, allow_alert, silent, created_by, secret_hash, secret_created_by)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $8)
			RETURNING `+hookColumns, "hk_"+id, s.cfg.TenantID, req.GetChatId(), name, string(kind), req.GetAllowAlert(),
			req.GetSilent(), me, hash))
		if err != nil {
			return fmt.Errorf("hooks: create hook: %w", err)
		}
		h = row
		return s.audit(ctx, tx, h, me, "created", string(kind))
	})
	if err != nil {
		return nil, err
	}
	return &appv1.CreateIncomingHookResponse{Hook: h.render(time.Now()), Url: s.url(h, secret)}, nil
}

// GetIncomingHooks lists the hooks of a chat me administers.
func (s *Service) GetIncomingHooks(ctx context.Context, me, chatID int64) (*appv1.GetIncomingHooksResponse, error) {
	if err := s.chat.CheckChatAdmin(ctx, chatID, me); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `SELECT `+hookColumns+` FROM incoming_hooks WHERE chat_id = $1 AND tenant_id = $2
		ORDER BY created_at, id`, chatID, s.cfg.TenantID)
	if err != nil {
		return nil, fmt.Errorf("hooks: list hooks: %w", err)
	}
	hooks, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (*hookRow, error) { return scanHook(r) })
	if err != nil {
		return nil, fmt.Errorf("hooks: list hooks: %w", err)
	}
	s.counters.overlayLastUsed(hooks)
	now := time.Now()
	out := &appv1.GetIncomingHooksResponse{}
	var ids []int64
	for _, h := range hooks {
		out.Hooks = append(out.Hooks, h.render(now))
		ids = append(ids, h.CreatedBy, h.SecretCreatedBy)
	}
	if out.Users, err = s.users(ctx, me, ids); err != nil {
		return nil, err
	}
	return out, nil
}

// GetIncomingHook returns one hook.
func (s *Service) GetIncomingHook(ctx context.Context, me int64, hookID string) (*appv1.GetIncomingHookResponse, error) {
	h, err := s.readable(ctx, me, hookID)
	if err != nil {
		return nil, err
	}
	s.counters.overlayLastUsed([]*hookRow{h})
	users, err := s.users(ctx, me, []int64{h.CreatedBy, h.SecretCreatedBy})
	if err != nil {
		return nil, err
	}
	return &appv1.GetIncomingHookResponse{Hook: h.render(time.Now()), Users: users}, nil
}

// rotate gives h a new secret; the current one becomes the previous secret
// for SecretGrace, or stops at once when revokePrevious.
func (s *Service) rotate(ctx context.Context, tx pgx.Tx, h *hookRow, me int64, revokePrevious bool) (string, error) {
	secret, hash, err := newSecret()
	if err != nil {
		return "", err
	}
	row, err := scanHook(tx.QueryRow(ctx, `
		UPDATE incoming_hooks SET
			prev_secret_hash = CASE WHEN $4 THEN NULL ELSE secret_hash END,
			prev_expires_at = CASE WHEN $4 THEN NULL ELSE $5::timestamptz END,
			secret_hash = $2, secret_created_at = now(), secret_created_by = $3, updated_at = now()
		WHERE id = $1 RETURNING `+hookColumns, h.ID, hash, me, revokePrevious, time.Now().Add(SecretGrace)))
	if err != nil {
		return "", fmt.Errorf("hooks: rotate secret: %w", err)
	}
	*h = *row
	detail := "grace_7d"
	if revokePrevious {
		detail = "previous_revoked"
	}
	if err := s.audit(ctx, tx, h, me, "secret_rotated", detail); err != nil {
		return "", err
	}
	return secret, nil
}

// RotateIncomingHookSecret issues a new secret.
func (s *Service) RotateIncomingHookSecret(ctx context.Context, me int64, req *appv1.RotateIncomingHookSecretRequest) (*appv1.RotateIncomingHookSecretResponse, error) {
	var secret string
	h, err := s.manage(ctx, me, req.GetHookId(), func(it *chat.IntegrationTx, h *hookRow) error {
		var err error
		secret, err = s.rotate(ctx, it.Tx(), h, me, req.GetRevokePrevious())
		return err
	})
	if err != nil {
		return nil, err
	}
	return &appv1.RotateIncomingHookSecretResponse{Hook: h.render(time.Now()), Url: s.url(h, secret)}, nil
}

// RevokePreviousHookSecret ends the grace period of the previous secret.
func (s *Service) RevokePreviousHookSecret(ctx context.Context, me int64, hookID string) (*appv1.RevokePreviousHookSecretResponse, error) {
	h, err := s.manage(ctx, me, hookID, func(it *chat.IntegrationTx, h *hookRow) error {
		tx := it.Tx()
		if h.PrevHash == nil || h.PrevExpiresAt == nil || !h.PrevExpiresAt.After(time.Now()) {
			return errPrecondition("no_previous_secret: the hook has no previous secret in its grace period")
		}
		if _, err := tx.Exec(ctx, `UPDATE incoming_hooks SET prev_secret_hash = NULL, prev_expires_at = NULL, updated_at = now()
			WHERE id = $1`, h.ID); err != nil {
			return fmt.Errorf("hooks: revoke previous secret: %w", err)
		}
		h.PrevHash, h.PrevExpiresAt = nil, nil
		return s.audit(ctx, tx, h, me, "previous_secret_revoked", "")
	})
	if err != nil {
		return nil, err
	}
	return &appv1.RevokePreviousHookSecretResponse{Hook: h.render(time.Now())}, nil
}

// SetIncomingHookEnabled turns a hook off, or on when its creator is still
// an admin of the chat.
func (s *Service) SetIncomingHookEnabled(ctx context.Context, me int64, req *appv1.SetIncomingHookEnabledRequest) (*appv1.SetIncomingHookEnabledResponse, error) {
	h, err := s.manage(ctx, me, req.GetHookId(), func(it *chat.IntegrationTx, h *hookRow) error {
		tx := it.Tx()
		if !req.GetEnabled() {
			if h.State != "active" {
				return nil
			}
			if err := s.setState(ctx, tx, h, me, "disabled", "by_admin", "disabled"); err != nil {
				return err
			}
			return it.HookStopped(ctx, me, h.Name, appv1.IncomingHookStopReason_INCOMING_HOOK_STOP_REASON_DISABLED)
		}
		if h.State == "active" {
			return nil
		}
		if h.DisabledReason == reasonByModerator {
			return errDisabledByModerator()
		}
		admin, err := chat.IsChatAdmin(ctx, tx, h.ChatID, h.CreatedBy)
		if err != nil {
			return err
		}
		if !admin {
			return errPrecondition("creator_not_admin: the creator is no longer an admin; take the webhook over instead")
		}
		return s.setState(ctx, tx, h, me, "active", "", "enabled")
	})
	if err != nil {
		return nil, err
	}
	return &appv1.SetIncomingHookEnabledResponse{Hook: h.render(time.Now())}, nil
}

func (s *Service) setState(ctx context.Context, tx pgx.Tx, h *hookRow, me int64, state, reason, action string) error {
	row, err := scanHook(tx.QueryRow(ctx, `
		UPDATE incoming_hooks SET state = $2, disabled_reason = $3,
			disabled_at = CASE WHEN $2 = 'active' THEN NULL ELSE now() END, updated_at = now()
		WHERE id = $1 RETURNING `+hookColumns, h.ID, state, reason))
	if err != nil {
		return fmt.Errorf("hooks: set state: %w", err)
	}
	*h = *row
	return s.audit(ctx, tx, h, me, action, "")
}

// TakeOverIncomingHook makes me the creator of the hook and turns it on;
// with rotateSecret the old URL stops at once.
func (s *Service) TakeOverIncomingHook(ctx context.Context, me int64, req *appv1.TakeOverIncomingHookRequest) (*appv1.TakeOverIncomingHookResponse, error) {
	var secret string
	h, err := s.manage(ctx, me, req.GetHookId(), func(it *chat.IntegrationTx, h *hookRow) error {
		tx := it.Tx()
		if h.DisabledReason == reasonByModerator {
			return errDisabledByModerator()
		}
		previous := h.CreatedBy
		row, err := scanHook(tx.QueryRow(ctx, `
			UPDATE incoming_hooks SET created_by = $2, state = 'active', disabled_reason = '', disabled_at = NULL, updated_at = now()
			WHERE id = $1 RETURNING `+hookColumns, h.ID, me))
		if err != nil {
			return fmt.Errorf("hooks: take over: %w", err)
		}
		*h = *row
		if err := s.audit(ctx, tx, h, me, "taken_over", fmt.Sprintf("from user %d", previous)); err != nil {
			return err
		}
		if req.GetRotateSecret() {
			secret, err = s.rotate(ctx, tx, h, me, true)
		}
		return err
	})
	if err != nil {
		return nil, err
	}
	out := &appv1.TakeOverIncomingHookResponse{Hook: h.render(time.Now())}
	if secret != "" {
		out.Url = s.url(h, secret)
	}
	return out, nil
}

// DeleteIncomingHook deletes a hook with its alert groups and idempotency
// keys; its audit entries stay.
func (s *Service) DeleteIncomingHook(ctx context.Context, me int64, hookID string) error {
	_, err := s.manage(ctx, me, hookID, func(it *chat.IntegrationTx, h *hookRow) error {
		tx := it.Tx()
		if _, err := tx.Exec(ctx, `DELETE FROM incoming_hooks WHERE id = $1`, h.ID); err != nil {
			return fmt.Errorf("hooks: delete hook: %w", err)
		}
		if err := s.audit(ctx, tx, h, me, "deleted", ""); err != nil {
			return err
		}
		return it.HookStopped(ctx, me, h.Name, appv1.IncomingHookStopReason_INCOMING_HOOK_STOP_REASON_DELETED)
	})
	return err
}

// UpdateIncomingHook changes the name, allow_alert and silent of a hook.
// Nothing changes (and nothing is audited) when they are already set.
func (s *Service) UpdateIncomingHook(ctx context.Context, me int64, req *appv1.UpdateIncomingHookRequest) (*appv1.UpdateIncomingHookResponse, error) {
	name, err := cleanName(req.GetName())
	if err != nil {
		return nil, err
	}
	h, err := s.manage(ctx, me, req.GetHookId(), func(it *chat.IntegrationTx, h *hookRow) error {
		changes := settingChanges(h, name, req.GetAllowAlert(), req.GetSilent())
		if len(changes) == 0 {
			return nil
		}
		tx := it.Tx()
		row, err := scanHook(tx.QueryRow(ctx, `
			UPDATE incoming_hooks SET name = $2, allow_alert = $3, silent = $4, updated_at = now()
			WHERE id = $1 RETURNING `+hookColumns, h.ID, name, req.GetAllowAlert(), req.GetSilent()))
		if err != nil {
			return fmt.Errorf("hooks: update hook: %w", err)
		}
		*h = *row
		return s.audit(ctx, tx, h, me, "updated", strings.Join(changes, ", "))
	})
	if err != nil {
		return nil, err
	}
	s.counters.overlayLastUsed([]*hookRow{h})
	return &appv1.UpdateIncomingHookResponse{Hook: h.render(time.Now())}, nil
}

// settingChanges describes, for the audit log, how the settings differ from
// h: `name (was "Old")`, `allow_alert on`, `silent off`.
func settingChanges(h *hookRow, name string, allowAlert, silent bool) []string {
	onOff := func(on bool) string {
		if on {
			return "on"
		}
		return "off"
	}
	var changes []string
	if name != h.Name {
		changes = append(changes, fmt.Sprintf("name (was %q)", h.Name))
	}
	if allowAlert != h.AllowAlert {
		changes = append(changes, "allow_alert "+onOff(allowAlert))
	}
	if silent != h.Silent {
		changes = append(changes, "silent "+onOff(silent))
	}
	return changes
}

// GetIncomingHookStats returns the counters of the last hours.
func (s *Service) GetIncomingHookStats(ctx context.Context, me int64, req *appv1.GetIncomingHookStatsRequest) (*appv1.GetIncomingHookStatsResponse, error) {
	hours := int(req.GetHours())
	if hours == 0 {
		hours = statsHoursDef
	}
	if hours < 1 || hours > statsHoursMax {
		return nil, errInvalid("hours must be between 1 and %d", statsHoursMax)
	}
	h, err := s.readable(ctx, me, req.GetHookId())
	if err != nil {
		return nil, err
	}
	// Counts still in memory are written first, so the answer is current.
	if err := s.Flush(ctx); err != nil {
		return nil, err
	}
	since := time.Now().Add(-time.Duration(hours) * time.Hour).Truncate(time.Hour)
	out := &appv1.GetIncomingHookStatsResponse{Hours: int32(hours)}
	if err := s.pool.QueryRow(ctx, `
		SELECT coalesce(sum(accepted), 0), coalesce(sum(delivered_realtime), 0), coalesce(sum(failed), 0)
		FROM hook_counters WHERE hook_id = $1 AND hour >= $2`, h.ID, since).Scan(&out.Accepted, &out.DeliveredRealtime, &out.Failed); err != nil {
		return nil, fmt.Errorf("hooks: read counters: %w", err)
	}
	rows, err := s.pool.Query(ctx, `
		SELECT reason, sum(count), max(last_at) FROM hook_failures WHERE hook_id = $1 AND hour >= $2
		GROUP BY reason ORDER BY sum(count) DESC, reason`, h.ID, since)
	if err != nil {
		return nil, fmt.Errorf("hooks: read failures: %w", err)
	}
	out.Failures, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (*appv1.IncomingHookFailure, error) {
		f := &appv1.IncomingHookFailure{}
		var last time.Time
		if err := r.Scan(&f.Reason, &f.Count, &last); err != nil {
			return nil, err
		}
		f.LastAt = last.Unix()
		return f, nil
	})
	if err != nil {
		return nil, fmt.Errorf("hooks: read failures: %w", err)
	}
	return out, nil
}

func pageLimit(limit int32) (int, error) {
	switch {
	case limit == 0:
		return pageDefault, nil
	case limit < 0 || limit > pageMax:
		return 0, errInvalid("limit must be between 1 and %d", pageMax)
	default:
		return int(limit), nil
	}
}

// GetIncomingHookDeadLetters pages through the hook's dead letters.
func (s *Service) GetIncomingHookDeadLetters(ctx context.Context, me int64, req *appv1.GetIncomingHookDeadLettersRequest) (*appv1.GetIncomingHookDeadLettersResponse, error) {
	limit, err := pageLimit(req.GetLimit())
	if err != nil {
		return nil, err
	}
	h, err := s.readable(ctx, me, req.GetHookId())
	if err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id, created_at, reason, detail, http_status, content_type, body, body_truncated FROM hook_dead_letters
		WHERE hook_id = $1 AND ($2 = 0 OR id < $2) ORDER BY id DESC LIMIT $3`, h.ID, req.GetBeforeId(), limit)
	if err != nil {
		return nil, fmt.Errorf("hooks: read dead letters: %w", err)
	}
	letters, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (*appv1.IncomingHookDeadLetter, error) {
		d := &appv1.IncomingHookDeadLetter{}
		var at time.Time
		if err := r.Scan(&d.Id, &at, &d.Reason, &d.Detail, &d.HttpStatus, &d.ContentType, &d.Body, &d.BodyTruncated); err != nil {
			return nil, err
		}
		d.Date = at.Unix()
		return d, nil
	})
	if err != nil {
		return nil, fmt.Errorf("hooks: read dead letters: %w", err)
	}
	return &appv1.GetIncomingHookDeadLettersResponse{DeadLetters: letters}, nil
}

// GetIncomingHookAudit pages through the audit log of a chat's hooks.
func (s *Service) GetIncomingHookAudit(ctx context.Context, me int64, req *appv1.GetIncomingHookAuditRequest) (*appv1.GetIncomingHookAuditResponse, error) {
	limit, err := pageLimit(req.GetLimit())
	if err != nil {
		return nil, err
	}
	if err := s.chat.CheckChatAdmin(ctx, req.GetChatId(), me); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id, created_at, hook_id, hook_name, actor_id, action, detail FROM hook_audit
		WHERE chat_id = $1 AND tenant_id = $2 AND ($3 = '' OR hook_id = $3) AND ($4 = 0 OR id < $4)
		ORDER BY id DESC LIMIT $5`, req.GetChatId(), s.cfg.TenantID, req.GetHookId(), req.GetBeforeId(), limit)
	if err != nil {
		return nil, fmt.Errorf("hooks: read audit: %w", err)
	}
	var actors []int64
	entries, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (*appv1.IncomingHookAuditEntry, error) {
		e := &appv1.IncomingHookAuditEntry{}
		var at time.Time
		var action string
		if err := r.Scan(&e.Id, &at, &e.HookId, &e.HookName, &e.ActorId, &action, &e.Detail); err != nil {
			return nil, err
		}
		e.Date, e.Action = at.Unix(), auditActionOf[action]
		actors = append(actors, e.ActorId)
		return e, nil
	})
	if err != nil {
		return nil, fmt.Errorf("hooks: read audit: %w", err)
	}
	users, err := s.users(ctx, me, actors)
	if err != nil {
		return nil, err
	}
	return &appv1.GetIncomingHookAuditResponse{Entries: entries, Users: users}, nil
}

// errHookOff: the hook was turned off between authentication and the
// delivery transaction.
var errHookOff = errors.New("hook is not active")

// reasonByModerator is the disabled_reason of a hook the moderation team
// turned off (chat.ResolveReport); chat admins cannot turn it back on.
const reasonByModerator = "by_moderator"

func errDisabledByModerator() error {
	return errPrecondition("disabled_by_moderator: the moderation team turned this webhook off")
}
