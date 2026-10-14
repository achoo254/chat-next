package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// GrantCandidate is a session whose IdP grant is due for a check.
type GrantCandidate struct {
	SessionID       int64
	TenantID        string
	UserID          int64
	IdPSub          string
	TokenHash       []byte
	RefreshTokenEnc []byte // nil when the IdP issued no refresh token
}

// GrantResult is what a grant check concluded.
type GrantResult int

// Grant check results.
const (
	// GrantAlive: the IdP still honours the grant (or there is nothing to
	// refresh); the check time moves to now.
	GrantAlive GrantResult = iota + 1
	// GrantEnded: the IdP answered invalid_grant; the session is revoked.
	GrantEnded
	// GrantRetry: the IdP could not be reached or failed; the session stays
	// and the check runs again after GrantOutcome.RetryAfter.
	GrantRetry
)

// GrantOutcome is applied to the locked session row before the lock is
// released.
type GrantOutcome struct {
	Result GrantResult
	// For GrantAlive: the rotated tokens (nil keeps the stored value) and the
	// email state the IdP reported (nil keeps it).
	RefreshTokenEnc []byte
	IDTokenEnc      []byte
	Email           *IdPEmail
	// For GrantRetry.
	RetryAfter time.Duration
}

// CheckGrant runs check for the session when its last grant check is at
// least interval old. The row stays locked (FOR UPDATE) while check runs, and
// concurrent callers skip a locked row (SKIP LOCKED), so a refresh token is
// never sent to the IdP twice; the rotated token is stored before the lock is
// released. ran reports whether check was called.
func (s *Store) CheckGrant(ctx context.Context, sessionID int64, interval time.Duration,
	check func(context.Context, GrantCandidate) GrantOutcome,
) (ran bool, err error) {
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		var c GrantCandidate
		err := tx.QueryRow(ctx, `
			SELECT s.id, s.tenant_id, s.user_id, u.idp_sub, s.token_hash, s.refresh_token_enc
			FROM user_sessions s JOIN users u ON u.id = s.user_id
			WHERE s.id = $1 AND `+activeSession+` AND s.idp_checked_at <= now() - $2::interval
			FOR UPDATE OF s SKIP LOCKED`,
			sessionID, interval).Scan(&c.SessionID, &c.TenantID, &c.UserID, &c.IdPSub, &c.TokenHash, &c.RefreshTokenEnc)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		ran = true
		out := check(ctx, c)
		switch out.Result {
		case GrantAlive:
			if _, err := tx.Exec(ctx, `
				UPDATE user_sessions SET idp_checked_at = now(),
					refresh_token_enc = coalesce($2, refresh_token_enc),
					id_token_enc = coalesce($3, id_token_enc)
				WHERE id = $1`, c.SessionID, out.RefreshTokenEnc, out.IDTokenEnc); err != nil {
				return err
			}
			if out.Email != nil {
				return updateUserEmail(ctx, tx, c.TenantID, c.UserID, *out.Email)
			}
			return nil
		case GrantEnded:
			_, err := tx.Exec(ctx, `
				UPDATE user_sessions SET revoked_at = now(), refresh_token_enc = NULL, id_token_enc = NULL
				WHERE id = $1`, c.SessionID)
			return err
		case GrantRetry:
			// Backdate the check so it becomes due again after RetryAfter.
			_, err := tx.Exec(ctx, `
				UPDATE user_sessions SET idp_checked_at = now() - $2::interval + $3::interval
				WHERE id = $1`, c.SessionID, interval, out.RetryAfter)
			return err
		default:
			return fmt.Errorf("unknown grant result %d", out.Result)
		}
	})
	if err != nil {
		return ran, fmt.Errorf("store: check grant: %w", err)
	}
	return ran, nil
}
