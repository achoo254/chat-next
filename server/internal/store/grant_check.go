package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// Grant check timing.
const (
	// GrantLease is how long a claimed grant check owns its session. The
	// check function must return well within it: once it expires another
	// caller may claim the session and send the same refresh token again.
	GrantLease = 2 * time.Minute
	// GrantWriteTimeout bounds the write of a grant check outcome. The write
	// runs on a context detached from the caller's, so a refresh token the
	// IdP already rotated is still stored when the caller's deadline passed.
	GrantWriteTimeout = 5 * time.Second
)

// ErrGrantNotApplied reports a grant check outcome that was not written
// because the session was revoked (or its lease lost) while the IdP was
// being consulted.
var ErrGrantNotApplied = errors.New("store: grant check outcome not applied")

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

// GrantOutcome is written to the session while the check still holds its
// lease.
type GrantOutcome struct {
	Result GrantResult
	// For GrantAlive: the rotated tokens (nil keeps the stored value) and
	// what the IdP reported about the user (nil keeps the user unchanged),
	// applied like a sign-in does (UpsertIdPUser). Profile.Sub must be the
	// session user's subject.
	RefreshTokenEnc []byte
	IDTokenEnc      []byte
	Profile         *IdPProfile
	// For GrantRetry.
	RetryAfter time.Duration
}

// CheckGrant runs check for the session when its last grant check is at
// least interval old and no other check holds it.
//
// The session is claimed with a single UPDATE that sets a lease of
// GrantLease; concurrent callers (in any process) find it leased and skip,
// so a refresh token is never sent to the IdP twice. check runs outside any
// transaction, so revocation, logout and activity updates of the session
// never wait on the IdP. The outcome is then written on a detached context
// (GrantWriteTimeout), only if the lease is still this check's and the
// session was not revoked meanwhile; otherwise ErrGrantNotApplied is
// returned. ran reports whether check was called.
func (s *Store) CheckGrant(ctx context.Context, sessionID int64, interval time.Duration,
	check func(context.Context, GrantCandidate) GrantOutcome,
) (ran bool, err error) {
	c, lease, ok, err := s.claimGrantCheck(ctx, sessionID, interval)
	if err != nil || !ok {
		return false, err
	}
	out := check(ctx, c)
	wctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), GrantWriteTimeout)
	defer cancel()
	if err := s.finishGrantCheck(wctx, c, lease, interval, out); err != nil {
		if errors.Is(err, ErrGrantNotApplied) {
			return true, err
		}
		return true, fmt.Errorf("store: check grant: %w", err)
	}
	return true, nil
}

// claimGrantCheck leases the session when it is active, due and not leased
// by a running check. ok is false when there is nothing to claim.
func (s *Store) claimGrantCheck(ctx context.Context, sessionID int64, interval time.Duration) (c GrantCandidate, lease time.Time, ok bool, err error) {
	err = s.pool.QueryRow(ctx, `
		UPDATE user_sessions s SET grant_lease_until = now() + $3::interval
		FROM users u
		WHERE s.id = $1 AND u.id = s.user_id AND `+activeSession+`
			AND s.idp_checked_at <= now() - $2::interval
			AND (s.grant_lease_until IS NULL OR s.grant_lease_until <= now())
		RETURNING s.id, s.tenant_id, s.user_id, u.idp_sub, s.token_hash, s.refresh_token_enc, s.grant_lease_until`,
		sessionID, interval, GrantLease).Scan(&c.SessionID, &c.TenantID, &c.UserID, &c.IdPSub, &c.TokenHash, &c.RefreshTokenEnc, &lease)
	if errors.Is(err, pgx.ErrNoRows) {
		return GrantCandidate{}, time.Time{}, false, nil
	}
	if err != nil {
		return GrantCandidate{}, time.Time{}, false, fmt.Errorf("store: claim grant check: %w", err)
	}
	return c, lease, true, nil
}

// leaseHeld is the SQL predicate (parameters $1 session id, $2 lease) of a
// session still leased by this check and not revoked meanwhile.
const leaseHeld = `id = $1 AND grant_lease_until = $2 AND revoked_at IS NULL`

// finishGrantCheck writes the outcome and releases the lease.
func (s *Store) finishGrantCheck(ctx context.Context, c GrantCandidate, lease time.Time, interval time.Duration, out GrantOutcome) error {
	switch out.Result {
	case GrantAlive:
		return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
			tag, err := tx.Exec(ctx, `
				UPDATE user_sessions SET idp_checked_at = now(), grant_lease_until = NULL,
					refresh_token_enc = coalesce($3, refresh_token_enc),
					id_token_enc = coalesce($4, id_token_enc)
				WHERE `+leaseHeld, c.SessionID, lease, out.RefreshTokenEnc, out.IDTokenEnc)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				return ErrGrantNotApplied
			}
			if out.Profile == nil {
				return nil
			}
			if out.Profile.Sub != c.IdPSub {
				return errors.New("grant check profile is not the session user's")
			}
			_, err = refreshIdPUser(ctx, tx, c.TenantID, *out.Profile)
			return err
		})
	case GrantEnded:
		return s.execLeased(ctx, `
			UPDATE user_sessions SET revoked_at = now(), grant_lease_until = NULL,
				refresh_token_enc = NULL, id_token_enc = NULL, revoke_reason = `+reasonGrantEnded+`
			WHERE `+leaseHeld, c.SessionID, lease)
	case GrantRetry:
		// Backdate the check so it becomes due again after RetryAfter.
		return s.execLeased(ctx, `
			UPDATE user_sessions SET idp_checked_at = now() - $3::interval + $4::interval, grant_lease_until = NULL
			WHERE `+leaseHeld, c.SessionID, lease, interval, out.RetryAfter)
	default:
		return fmt.Errorf("unknown grant result %d", out.Result)
	}
}

// execLeased runs one leased update; ErrGrantNotApplied when it matched no
// row.
func (s *Store) execLeased(ctx context.Context, sql string, args ...any) error {
	tag, err := s.pool.Exec(ctx, sql, args...)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrGrantNotApplied
	}
	return nil
}
