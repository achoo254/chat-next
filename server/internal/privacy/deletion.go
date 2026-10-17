package privacy

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/profile"
	"github.com/jackc/pgx/v5"
)

// Deletion of the chat account.
//
// DeleteAccount (recent IdP sign-in, typed username, no owned group or
// channel) sets users.deletion_requested_at: from then on the account is
// locked (its sessions are revoked with their IdP grants, a new sign-in may
// only cancel), others see it as "Tài khoản đã xoá", nobody can find or
// write to it, and its bots are stopped. CancelAccountDeletion undoes all of
// that. GracePeriod later the purge job erases it: the account leaves its
// chats (LeaveAllChats), its saved chat and the private chats nobody alive
// keeps are deleted, its personal rows go, its bots are deleted, and the
// users row stays only as the anonymous author of the messages it sent in
// other people's chats, with the username released and idp_sub cleared, so
// signing in again creates a new, empty account. Files nobody references
// any more are collected by the media lifecycle.

// deletionReasons maps users.deletion_reason to the protocol.
var deletionReasons = map[string]appv1.AccountDeletionReason{
	"user":     appv1.AccountDeletionReason_ACCOUNT_DELETION_REASON_USER,
	"inactive": appv1.AccountDeletionReason_ACCOUNT_DELETION_REASON_INACTIVE,
}

// Deletion describes an account in its grace period for GetSelf; nil when
// requestedAt is nil.
func Deletion(requestedAt *time.Time, reason string) *appv1.AccountDeletion {
	if requestedAt == nil {
		return nil
	}
	return &appv1.AccountDeletion{
		RequestedAt: requestedAt.Unix(), PurgeAt: requestedAt.Add(GracePeriod).Unix(), Reason: deletionReasons[reason],
	}
}

// DeletionInfo is what the delete screen shows: blockers, bots, the
// auto-delete setting and when this session signed in at the IdP.
func (s *Service) DeletionInfo(ctx context.Context, me int64, authTime time.Time) (*appv1.GetAccountDeletionResponse, error) {
	owned, err := s.chat.OwnedChats(ctx, me)
	if err != nil {
		return nil, err
	}
	bots, err := s.bots.OwnedBots(ctx, me)
	if err != nil {
		return nil, err
	}
	var months int16
	if err := s.pool.QueryRow(ctx, `SELECT auto_delete_months FROM users WHERE id = $1 AND tenant_id = $2`,
		me, s.cfg.TenantID).Scan(&months); err != nil {
		return nil, fmt.Errorf("privacy: auto-delete setting: %w", err)
	}
	resp := &appv1.GetAccountDeletionResponse{
		OwnedChats: owned, Bots: bots, AutoDeleteMonths: int32(months), GraceDays: int32(GracePeriod / (24 * time.Hour)),
	}
	if !authTime.IsZero() {
		resp.SignedInAt = authTime.Unix()
	}
	return resp, nil
}

// SetAutoDelete stores the auto-delete period (0, 6, 12 or 24 months).
func (s *Service) SetAutoDelete(ctx context.Context, me int64, months int32) (int32, error) {
	if !slices.Contains(AutoDeleteMonths, months) {
		return 0, errInvalid("months must be 0, 6, 12 or 24")
	}
	if _, err := s.pool.Exec(ctx, `UPDATE users SET auto_delete_months = $3, updated_at = now() WHERE id = $1 AND tenant_id = $2`,
		me, s.cfg.TenantID, months); err != nil {
		return 0, fmt.Errorf("privacy: set auto-delete: %w", err)
	}
	return months, nil
}

// RequestDeletion starts the grace period of me's account. authTime is the
// session's IdP sign-in; confirmation must be me's username.
func (s *Service) RequestDeletion(ctx context.Context, me int64, authTime time.Time, confirmation string) (time.Time, error) {
	if authTime.IsZero() || s.now().Sub(authTime) > RecentSignIn {
		return time.Time{}, errReauth()
	}
	owned, err := s.chat.OwnedChats(ctx, me)
	if err != nil {
		return time.Time{}, err
	}
	if len(owned) > 0 {
		return time.Time{}, errPrecondition("owns_chats: transfer the ownership of your groups and channels, or delete them, first")
	}
	var requested time.Time
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		var username string
		var pending bool
		err := tx.QueryRow(ctx, `
			SELECT username, deletion_requested_at IS NOT NULL FROM users
			WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL AND NOT is_bot FOR UPDATE`,
			me, s.cfg.TenantID).Scan(&username, &pending)
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound("user")
		}
		if err != nil {
			return fmt.Errorf("privacy: load account: %w", err)
		}
		if pending {
			return errPrecondition("account_pending_deletion: the account already waits for deletion")
		}
		typed := profile.NormalizeUsername(strings.TrimPrefix(strings.TrimSpace(confirmation), "@"))
		if typed == "" || typed != username {
			return errInvalid("confirmation must be your username")
		}
		return s.lock(ctx, tx, me, "user", &requested)
	})
	if err != nil {
		return time.Time{}, err
	}
	s.afterLock(ctx, me)
	s.logger.Info("account deletion requested", "user_id", me)
	return requested.Add(GracePeriod), nil
}

// lock starts the grace period of a locked users row and cancels the
// export being built.
func (s *Service) lock(ctx context.Context, tx pgx.Tx, userID int64, reason string, requested *time.Time) error {
	if err := tx.QueryRow(ctx, `
		UPDATE users SET deletion_requested_at = now(), deletion_reason = $2, updated_at = now() WHERE id = $1
		RETURNING deletion_requested_at`, userID, reason).Scan(requested); err != nil {
		return fmt.Errorf("privacy: lock account: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE data_exports SET status = 'failed', error = 'account_deleted', lease_until = NULL
		WHERE user_id = $1 AND status IN ('pending', 'running')`, userID); err != nil {
		return fmt.Errorf("privacy: cancel exports: %w", err)
	}
	return nil
}

// afterLock ends the sessions of a just-locked account (with their IdP
// grants) and tells its chat partners. Both are retried by nothing: a
// failure is logged, the lock itself already keeps the account out (its
// sessions cannot be used, see store.ActiveSession).
func (s *Service) afterLock(ctx context.Context, userID int64) {
	if n, err := s.revoke.RevokeAll(ctx, userID); err != nil {
		s.logger.Error("revoking the sessions of a deleted account failed", "user_id", userID, "err", err)
	} else {
		s.logger.Info("sessions of a deleted account revoked", "user_id", userID, "sessions", n)
	}
	if err := s.chat.AnnounceUserChanged(ctx, userID); err != nil {
		s.logger.Error("announcing a deleted account failed", "user_id", userID, "err", err)
	}
}

// CancelDeletion ends the grace period of me's account: it works as before.
func (s *Service) CancelDeletion(ctx context.Context, me int64) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE users SET deletion_requested_at = NULL, deletion_reason = NULL, updated_at = now()
		WHERE id = $1 AND tenant_id = $2 AND deletion_requested_at IS NOT NULL AND deleted_at IS NULL`,
		me, s.cfg.TenantID)
	if err != nil {
		return fmt.Errorf("privacy: cancel deletion: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return errPrecondition("not_pending: the account is not waiting for deletion")
	}
	if err := s.chat.AnnounceUserChanged(ctx, me); err != nil {
		s.logger.Error("announcing a restored account failed", "user_id", me, "err", err)
	}
	s.logger.Info("account deletion cancelled", "user_id", me)
	return nil
}

// scheduleInactive starts the grace period of the accounts that opted in to
// auto-delete and have not used any session for that many months (an
// account never used since sign-up counts from its creation).
func (s *Service) scheduleInactive(ctx context.Context) (int, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT u.id FROM users u
		WHERE u.tenant_id = $1 AND u.auto_delete_months > 0 AND u.deleted_at IS NULL AND u.deletion_requested_at IS NULL
			AND NOT u.is_bot
			AND greatest(u.created_at, (SELECT max(s.last_seen_at) FROM user_sessions s WHERE s.user_id = u.id))
				< $2::timestamptz - make_interval(months => u.auto_delete_months)
		ORDER BY u.id LIMIT 500`, s.cfg.TenantID, s.now())
	if err != nil {
		return 0, fmt.Errorf("privacy: unused accounts: %w", err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return 0, fmt.Errorf("privacy: unused accounts: %w", err)
	}
	for _, id := range ids {
		var requested time.Time
		err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
			var pending bool
			if err := tx.QueryRow(ctx, `SELECT deletion_requested_at IS NOT NULL FROM users WHERE id = $1 FOR UPDATE`, id).
				Scan(&pending); err != nil {
				return fmt.Errorf("privacy: load account: %w", err)
			}
			if pending {
				return nil
			}
			return s.lock(ctx, tx, id, "inactive", &requested)
		})
		if err != nil {
			return 0, err
		}
		s.afterLock(ctx, id)
		s.logger.Info("unused account scheduled for deletion", "user_id", id)
	}
	return len(ids), nil
}

// purgeDue erases the accounts whose grace period has ended.
func (s *Service) purgeDue(ctx context.Context) (int, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id FROM users
		WHERE tenant_id = $1 AND deletion_requested_at IS NOT NULL AND deleted_at IS NULL
			AND deletion_requested_at <= $2::timestamptz - $3::interval
		ORDER BY deletion_requested_at LIMIT 100`, s.cfg.TenantID, s.now(), GracePeriod)
	if err != nil {
		return 0, fmt.Errorf("privacy: due accounts: %w", err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return 0, fmt.Errorf("privacy: due accounts: %w", err)
	}
	done := 0
	for _, id := range ids {
		if err := s.Erase(ctx, id); err != nil {
			return done, fmt.Errorf("privacy: erase account %d: %w", id, err)
		}
		done++
	}
	return done, nil
}

// personalRows are deleted when an account is erased ($1 is the user).
// Messages and reactions in other people's chats stay (their author shows
// as deleted), as do the reports it filed and the moderation log, which the
// operators keep (docs/privacy/data-inventory.md).
var personalRows = []string{
	`DELETE FROM contacts WHERE owner_id = $1 OR contact_id = $1`,
	`DELETE FROM blocks WHERE blocker_id = $1 OR blocked_id = $1`,
	`DELETE FROM privacy_settings WHERE user_id = $1`,
	`DELETE FROM notification_settings WHERE user_id = $1`,
	`DELETE FROM push_subscriptions WHERE user_id = $1`,
	`DELETE FROM user_sessions WHERE user_id = $1`,
	`DELETE FROM bot_user_consent WHERE user_id = $1`,
	`DELETE FROM account_restrictions WHERE user_id = $1`,
	`DELETE FROM feedback WHERE user_id = $1`,
	`DELETE FROM user_hidden_messages WHERE user_id = $1`,
	`DELETE FROM invite_links WHERE creator_id = $1`,
	`DELETE FROM user_updates WHERE user_id = $1`,
	`DELETE FROM user_state WHERE user_id = $1`,
}

// Erase removes a deleted account for good (see the comment at the top).
// Every step can run again, so an erasure cut short is finished by the next
// run of the job.
func (s *Service) Erase(ctx context.Context, userID int64) error {
	if err := s.chat.LeaveAllChats(ctx, userID); err != nil {
		return err
	}
	if _, err := s.bots.DeleteOwnedBots(ctx, userID); err != nil {
		return err
	}
	if err := s.deleteExportFiles(ctx, userID); err != nil {
		return err
	}
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		for _, sql := range personalRows {
			if _, err := tx.Exec(ctx, sql, userID); err != nil {
				return fmt.Errorf("privacy: erase personal data: %w", err)
			}
		}
		if _, err := tx.Exec(ctx, `DELETE FROM data_exports WHERE user_id = $1`, userID); err != nil {
			return fmt.Errorf("privacy: erase exports: %w", err)
		}
		name, err := freeUsername(ctx, tx, s.cfg.TenantID, userID)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE users SET username = $2, name = '', bio = '', email = NULL, email_verified = false, idp_sub = NULL,
				last_seen_at = NULL, auto_delete_months = 0, photo_file_id = NULL, deleted_at = now(), updated_at = now()
			WHERE id = $1`, userID, name); err != nil {
			return fmt.Errorf("privacy: erase profile: %w", err)
		}
		return nil
	})
	if err != nil {
		return err
	}
	s.logger.Info("deleted account erased", "user_id", userID)
	return nil
}

// freeUsername picks the placeholder username of an erased account,
// deleted_<id>, so its own becomes free; a random suffix is added when a
// person already holds that name.
func freeUsername(ctx context.Context, tx pgx.Tx, tenantID string, userID int64) (string, error) {
	base := "deleted_" + strconv.FormatInt(userID, 10)
	for attempt := range 3 {
		name := base
		if attempt > 0 {
			n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
			if err != nil {
				return "", fmt.Errorf("privacy: release username: %w", err)
			}
			name = fmt.Sprintf("%s_%06d", base, n.Int64())
		}
		var taken bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM users WHERE tenant_id = $1 AND username = $2 AND id <> $3)`,
			tenantID, name, userID).Scan(&taken); err != nil {
			return "", fmt.Errorf("privacy: release username: %w", err)
		}
		if !taken {
			return name, nil
		}
	}
	return "", errors.New("privacy: release username: every candidate name is taken")
}

// deleteExportFiles removes the export ZIPs of a user from the disk.
func (s *Service) deleteExportFiles(ctx context.Context, userID int64) error {
	rows, err := s.pool.Query(ctx, `SELECT file_name FROM data_exports WHERE user_id = $1 AND file_name <> ''`, userID)
	if err != nil {
		return fmt.Errorf("privacy: export files: %w", err)
	}
	names, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return fmt.Errorf("privacy: export files: %w", err)
	}
	for _, name := range names {
		s.removeExportFile(name)
	}
	return nil
}

// removeExportFile deletes one export ZIP (and a partial build of it).
func (s *Service) removeExportFile(name string) {
	if s.cfg.ExportDir == "" || name == "" || filepath.Base(name) != name {
		return
	}
	for _, p := range []string{filepath.Join(s.cfg.ExportDir, name), filepath.Join(s.cfg.ExportDir, name+".part")} {
		if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
			s.logger.Warn("deleting an export file failed", "file", name, "err", err)
		}
	}
}
