package privacy

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"strconv"

	"github.com/jackc/pgx/v5"
)

// Deletion of the chat account follows the IdP: an account is deleted only
// at the IdP's account page, which then tells every app (auth-next ADR 0018,
// chat ADR 0016). DeleteIdPAccount queues the erasure durably by setting
// users.deletion_requested_at, which locks the account at once (its
// sessions are revoked with their IdP grants, others see it as "Tài khoản
// đã xoá", nobody can find or write to it, its bots are stopped), and then
// erases it: the account leaves its chats, handing every group and channel
// it owns to the member with the highest role, then the earliest joiner,
// or deleting it when nobody else is left (LeaveAllChats); its saved chat
// and the private chats nobody alive keeps are deleted, its personal rows
// go, its bots are deleted, and the users row stays only as the anonymous
// author of the messages it sent in other people's chats, with the
// username released and idp_sub cleared. An erasure cut short is finished
// by the hourly job (eraseQueued). Files nobody references any more are
// collected by the media lifecycle.

// DeletionResult says what DeleteIdPAccount did.
type DeletionResult struct {
	// UserID is the chat user of the account; 0 when it has none (never
	// had one, or already erased).
	UserID int64
	// Erased: the erasure finished now. When false with a UserID, it is
	// queued and the job finishes it.
	Erased bool
}

// DeleteIdPAccount deletes the chat account of the IdP account sub. It
// returns an error only when the deletion could not even be queued; once
// queued, a failed erasure is logged and left to the job. Calling it again
// for the same sub is harmless.
func (s *Service) DeleteIdPAccount(ctx context.Context, sub string) (DeletionResult, error) {
	var userID int64
	var locked bool
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		var pending bool
		err := tx.QueryRow(ctx, `
			SELECT id, deletion_requested_at IS NOT NULL FROM users
			WHERE tenant_id = $1 AND idp_sub = $2 AND deleted_at IS NULL AND NOT is_bot FOR UPDATE`,
			s.cfg.TenantID, sub).Scan(&userID, &pending)
		if errors.Is(err, pgx.ErrNoRows) {
			userID = 0
			return nil
		}
		if err != nil {
			return fmt.Errorf("privacy: load account: %w", err)
		}
		if pending {
			return nil
		}
		locked = true
		return s.lock(ctx, tx, userID, "idp")
	})
	if err != nil {
		return DeletionResult{}, err
	}
	if userID == 0 {
		return DeletionResult{}, nil
	}
	if locked {
		s.afterLock(ctx, userID)
		s.logger.Info("account deleted at the IdP: erasure queued", "user_id", userID)
	}
	if err := s.Erase(ctx, userID); err != nil {
		s.logger.Error("erasing an account deleted at the IdP failed; the job retries", "user_id", userID, "err", err)
		return DeletionResult{UserID: userID}, nil
	}
	return DeletionResult{UserID: userID, Erased: true}, nil
}

// lock queues the erasure of a locked users row and cancels the export
// being built.
func (s *Service) lock(ctx context.Context, tx pgx.Tx, userID int64, reason string) error {
	if _, err := tx.Exec(ctx, `
		UPDATE users SET deletion_requested_at = now(), deletion_reason = $2, updated_at = now() WHERE id = $1`,
		userID, reason); err != nil {
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
// sessions cannot be used, see store.ActiveSession), and the erasure
// deletes the sessions and announces the account again.
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

// eraseQueued erases the accounts whose erasure is queued and not done:
// those an earlier erasure left part-way, and those that waited out the
// 30-day grace period of the chat's former own deletion (they are finished
// at once).
func (s *Service) eraseQueued(ctx context.Context) (int, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id FROM users
		WHERE tenant_id = $1 AND deletion_requested_at IS NOT NULL AND deleted_at IS NULL
		ORDER BY deletion_requested_at LIMIT 100`, s.cfg.TenantID)
	if err != nil {
		return 0, fmt.Errorf("privacy: queued accounts: %w", err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return 0, fmt.Errorf("privacy: queued accounts: %w", err)
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
// run of the job. Erasures of this process run one at a time, so the IdP's
// call and the job never work on the same account together.
func (s *Service) Erase(ctx context.Context, userID int64) error {
	s.erasing.Lock()
	defer s.erasing.Unlock()
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
			UPDATE users SET username = $2, name = '', bio = '', email = NULL, email_verified = false, idp_sub = NULL, idp_picture = NULL,
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
