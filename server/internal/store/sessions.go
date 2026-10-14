package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// Web session lifetime (ADR 0006): sliding 30 days, capped at 90 days after
// sign-in. Every query that treats a session as usable applies both.
const (
	SessionIdleTimeout = 30 * 24 * time.Hour
	SessionMaxAge      = 90 * 24 * time.Hour
)

// withinMaxAge and activeSession are the SQL predicates (alias s) of a
// session younger than SessionMaxAge, and of a usable session.
var (
	withinMaxAge  = fmt.Sprintf(`s.created_at > now() - interval '%d hours'`, int(SessionMaxAge.Hours()))
	activeSession = fmt.Sprintf(`s.revoked_at IS NULL AND s.last_seen_at > now() - interval '%d hours' AND %s`,
		int(SessionIdleTimeout.Hours()), withinMaxAge)
)

// Revocation reasons stored in user_sessions.revoke_reason (values of
// app.v1.SessionRevokeReason). A trigger copies them into the outbox row
// that tells the realtime gateway to close the session's sockets.
const (
	reasonSignedOut     = "1"
	reasonRevokedByUser = "2"
	reasonGrantEnded    = "3"
)

// Session is a chat session without its secrets.
type Session struct {
	ID           int64
	TenantID     string
	UserID       int64
	TokenHash    []byte
	IdPSID       string
	IdPClientID  string
	IdPCheckedAt time.Time
	CreatedAt    time.Time
	LastSeenAt   time.Time
	UserAgent    string
	IP           string
}

const sessionColumns = `s.id, s.tenant_id, s.user_id, s.token_hash, coalesce(s.idp_sid, ''), s.idp_client_id,
	s.idp_checked_at, s.created_at, s.last_seen_at, s.user_agent, coalesce(host(s.ip), '')`

func scanSession(row pgx.Row) (Session, error) {
	var x Session
	err := row.Scan(&x.ID, &x.TenantID, &x.UserID, &x.TokenHash, &x.IdPSID, &x.IdPClientID,
		&x.IdPCheckedAt, &x.CreatedAt, &x.LastSeenAt, &x.UserAgent, &x.IP)
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, ErrNotFound
	}
	return x, err
}

// NewSession is the data of a session at sign-in. The token encryptions are
// sealed by the caller.
type NewSession struct {
	TokenHash       []byte
	TenantID        string
	UserID          int64
	IdPSID          string
	IdPClientID     string
	RefreshTokenEnc []byte
	IDTokenEnc      []byte
	UserAgent       string
	IP              string // empty when unknown
}

// CreateSession inserts a session and returns its id.
func (s *Store) CreateSession(ctx context.Context, n NewSession) (int64, error) {
	var sid, ip *string
	if n.IdPSID != "" {
		sid = &n.IdPSID
	}
	if n.IP != "" {
		ip = &n.IP
	}
	var id int64
	err := s.pool.QueryRow(ctx, `
		INSERT INTO user_sessions (token_hash, tenant_id, user_id, idp_sid, idp_client_id,
			refresh_token_enc, id_token_enc, user_agent, ip)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::inet)
		RETURNING id`,
		n.TokenHash, n.TenantID, n.UserID, sid, n.IdPClientID, n.RefreshTokenEnc, n.IDTokenEnc, n.UserAgent, ip).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("store: create session: %w", err)
	}
	return id, nil
}

// ActiveSession returns the usable session whose token hashes to tokenHash.
func (s *Store) ActiveSession(ctx context.Context, tenantID string, tokenHash []byte) (Session, error) {
	x, err := scanSession(s.pool.QueryRow(ctx, `
		SELECT `+sessionColumns+` FROM user_sessions s
		WHERE s.tenant_id = $1 AND s.token_hash = $2 AND `+activeSession,
		tenantID, tokenHash))
	if err != nil && !errors.Is(err, ErrNotFound) {
		return Session{}, fmt.Errorf("store: active session: %w", err)
	}
	return x, err
}

// TouchSession moves last_seen_at to now when it is older than minInterval.
// A session whose row is locked by a concurrent write is skipped rather than
// waited on; the next request touches it.
func (s *Store) TouchSession(ctx context.Context, id int64, minInterval time.Duration) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE user_sessions SET last_seen_at = now()
		WHERE id = (SELECT id FROM user_sessions
			WHERE id = $1 AND last_seen_at < now() - $2::interval
			FOR UPDATE SKIP LOCKED)`,
		id, minInterval)
	if err != nil {
		return fmt.Errorf("store: touch session: %w", err)
	}
	return nil
}

// ListActiveSessions returns the usable sessions of a user, newest first.
func (s *Store) ListActiveSessions(ctx context.Context, tenantID string, userID int64) ([]Session, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+sessionColumns+` FROM user_sessions s
		WHERE s.tenant_id = $1 AND s.user_id = $2 AND `+activeSession+`
		ORDER BY s.created_at DESC, s.id DESC`,
		tenantID, userID)
	if err != nil {
		return nil, fmt.Errorf("store: list sessions: %w", err)
	}
	list, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Session, error) { return scanSession(row) })
	if err != nil {
		return nil, fmt.Errorf("store: list sessions: %w", err)
	}
	return list, nil
}

// RevokedSession carries what a caller needs to revoke the IdP grant of a
// session that was just revoked: the sealed refresh token and the token hash
// it is bound to. IDTokenEnc is only returned by EndSessionForLogout.
//
// Revocation clears the sealed tokens, except that a session revoked by its
// own holder (SignOut) keeps its ID token until /auth/logout hands it out
// once as id_token_hint. A session revoked from another one loses it, so a
// stolen cookie of that session cannot obtain the ID token.
type RevokedSession struct {
	ID              int64
	TokenHash       []byte
	RefreshTokenEnc []byte
	IDTokenEnc      []byte
}

func collectRevoked(rows pgx.Rows) ([]RevokedSession, error) {
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (RevokedSession, error) {
		var r RevokedSession
		err := row.Scan(&r.ID, &r.TokenHash, &r.RefreshTokenEnc)
		return r, err
	})
}

// RevokeSession revokes one active session of the user; ErrNotFound when the
// user has no such active session. callerTokenHash is the token hash of the
// session making the request (nil when unknown): the ID token is kept only
// when it is the revoked session itself, for the SignOut then /auth/logout
// flow.
func (s *Store) RevokeSession(ctx context.Context, tenantID string, userID, sessionID int64, callerTokenHash []byte) (RevokedSession, error) {
	rows, err := s.pool.Query(ctx, `
		WITH target AS (
			SELECT s.id, s.token_hash, s.refresh_token_enc FROM user_sessions s
			WHERE s.tenant_id = $1 AND s.user_id = $2 AND s.id = $3 AND `+activeSession+`
			FOR UPDATE)
		UPDATE user_sessions u SET revoked_at = now(), refresh_token_enc = NULL,
			id_token_enc = CASE WHEN u.token_hash = $4 THEN u.id_token_enc END,
			revoke_reason = CASE WHEN u.token_hash = $4 THEN `+reasonSignedOut+` ELSE `+reasonRevokedByUser+` END
		FROM target WHERE u.id = target.id
		RETURNING u.id, target.token_hash, target.refresh_token_enc`,
		tenantID, userID, sessionID, callerTokenHash)
	if err != nil {
		return RevokedSession{}, fmt.Errorf("store: revoke session: %w", err)
	}
	list, err := collectRevoked(rows)
	if err != nil {
		return RevokedSession{}, fmt.Errorf("store: revoke session: %w", err)
	}
	if len(list) == 0 {
		return RevokedSession{}, ErrNotFound
	}
	return list[0], nil
}

// RevokeOtherSessions revokes every active session of the user except keepID.
func (s *Store) RevokeOtherSessions(ctx context.Context, tenantID string, userID, keepID int64) ([]RevokedSession, error) {
	rows, err := s.pool.Query(ctx, `
		WITH target AS (
			SELECT s.id, s.token_hash, s.refresh_token_enc FROM user_sessions s
			WHERE s.tenant_id = $1 AND s.user_id = $2 AND s.id <> $3 AND `+activeSession+`
			FOR UPDATE)
		UPDATE user_sessions u SET revoked_at = now(), refresh_token_enc = NULL, id_token_enc = NULL,
			revoke_reason = `+reasonRevokedByUser+`
		FROM target WHERE u.id = target.id
		RETURNING u.id, target.token_hash, target.refresh_token_enc`,
		tenantID, userID, keepID)
	if err != nil {
		return nil, fmt.Errorf("store: revoke other sessions: %w", err)
	}
	list, err := collectRevoked(rows)
	if err != nil {
		return nil, fmt.Errorf("store: revoke other sessions: %w", err)
	}
	return list, nil
}

// EndSessionForLogout revokes the session of tokenHash if it is still active
// and hands back its sealed tokens exactly once, clearing them: the ID token
// becomes the id_token_hint of the RP-initiated logout. A session already
// revoked (for example by SignOut) still yields its ID token, so the web can
// call SignOut and then /auth/logout. ErrNotFound when there is no session or
// it is older than SessionMaxAge.
func (s *Store) EndSessionForLogout(ctx context.Context, tenantID string, tokenHash []byte) (RevokedSession, error) {
	var r RevokedSession
	err := s.pool.QueryRow(ctx, `
		WITH target AS (
			SELECT s.id, s.token_hash, s.refresh_token_enc, s.id_token_enc FROM user_sessions s
			WHERE s.tenant_id = $1 AND s.token_hash = $2 AND `+withinMaxAge+`
			FOR UPDATE)
		UPDATE user_sessions u SET revoked_at = coalesce(u.revoked_at, now()),
			revoke_reason = coalesce(u.revoke_reason, `+reasonSignedOut+`),
			refresh_token_enc = NULL, id_token_enc = NULL
		FROM target WHERE u.id = target.id
		RETURNING u.id, target.token_hash, target.refresh_token_enc, target.id_token_enc`,
		tenantID, tokenHash).Scan(&r.ID, &r.TokenHash, &r.RefreshTokenEnc, &r.IDTokenEnc)
	if errors.Is(err, pgx.ErrNoRows) {
		return RevokedSession{}, ErrNotFound
	}
	if err != nil {
		return RevokedSession{}, fmt.Errorf("store: end session for logout: %w", err)
	}
	return r, nil
}

// BackchannelLogout records the logout token's jti and, when it was not seen
// before, revokes the sessions of the IdP client that carry sid (or, without
// a sid, every session of the IdP subject). Both happen in one transaction so
// a failed revocation can be retried by the IdP. fresh is false for a replay.
func (s *Store) BackchannelLogout(ctx context.Context, tenantID, clientID, jti string, jtiTTL time.Duration, sid, sub string) (fresh bool, revoked int64, err error) {
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `DELETE FROM oidc_logout_jti WHERE expires_at < now()`); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `
			INSERT INTO oidc_logout_jti (jti, expires_at) VALUES ($1, now() + $2::interval)
			ON CONFLICT (jti) DO NOTHING`, jti, jtiTTL)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return nil
		}
		fresh = true
		if sid != "" {
			tag, err = tx.Exec(ctx, `
				UPDATE user_sessions SET revoked_at = now(), refresh_token_enc = NULL, id_token_enc = NULL,
					revoke_reason = `+reasonGrantEnded+`
				WHERE tenant_id = $1 AND idp_client_id = $2 AND idp_sid = $3 AND revoked_at IS NULL`,
				tenantID, clientID, sid)
		} else {
			tag, err = tx.Exec(ctx, `
				UPDATE user_sessions s SET revoked_at = now(), refresh_token_enc = NULL, id_token_enc = NULL,
					revoke_reason = `+reasonGrantEnded+`
				FROM users u
				WHERE u.id = s.user_id AND u.tenant_id = $1 AND u.idp_sub = $3
					AND s.tenant_id = $1 AND s.idp_client_id = $2 AND s.revoked_at IS NULL`,
				tenantID, clientID, sub)
		}
		if err != nil {
			return err
		}
		revoked = tag.RowsAffected()
		return nil
	})
	if err != nil {
		return false, 0, fmt.Errorf("store: back-channel logout: %w", err)
	}
	return fresh, revoked, nil
}
