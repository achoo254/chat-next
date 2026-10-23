package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// Session lifetime (ADR 0006): sliding 30 days; a web session is also
// capped at 90 days after sign-in, a native app session (bound to its
// device's IdP grant) is not. Every query that treats a session as usable
// applies both.
const (
	SessionIdleTimeout = 30 * 24 * time.Hour
	SessionMaxAge      = 90 * 24 * time.Hour
)

// Session platforms (user_sessions.platform, values of
// app.v1.ClientPlatform). Only ExchangeNativeCode creates iOS and Android
// sessions.
const (
	PlatformWeb     int16 = 1
	PlatformIOS     int16 = 2
	PlatformAndroid int16 = 3
)

// withinMaxAge and activeSession are the SQL predicates (alias s) of a
// session younger than SessionMaxAge, and of a usable session.
var (
	withinMaxAge  = fmt.Sprintf(`s.created_at > now() - interval '%d hours'`, int(SessionMaxAge.Hours()))
	activeSession = fmt.Sprintf(`s.revoked_at IS NULL AND s.last_seen_at > now() - interval '%d hours' AND (%s OR s.platform IN (%d, %d))`,
		int(SessionIdleTimeout.Hours()), withinMaxAge, PlatformIOS, PlatformAndroid)
)

// Revocation reasons stored in user_sessions.revoke_reason (values of
// app.v1.SessionRevokeReason). A trigger copies them into the outbox row
// that tells the realtime gateway to close the session's sockets.
const (
	reasonSignedOut     = "1"
	reasonRevokedByUser = "2"
	reasonGrantEnded    = "3"
	reasonReplaced      = "6"
	// ReasonAccountDeleted: the account entered its deletion grace period.
	reasonAccountDeleted = "7"
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
	// AuthTime is when the user last authenticated at the IdP for this
	// session (the ID token's auth_time at sign-in); zero when unknown.
	AuthTime time.Time
	// AccountLocked: the user's account waits for deletion. Only
	// ActiveSession fills it; such a session may only cancel the deletion
	// or sign out.
	AccountLocked bool
	// Platform is PlatformWeb, PlatformIOS or PlatformAndroid.
	Platform int16
	// DeviceName and AppVersion are what a native app reported at sign-in
	// ("" for web sessions).
	DeviceName string
	AppVersion string
}

// Native reports a session of the iOS or Android app: it authenticates with
// the Authorization header (never the cookie) and has no maximum age.
func (x Session) Native() bool {
	return x.Platform == PlatformIOS || x.Platform == PlatformAndroid
}

const sessionColumns = `s.id, s.tenant_id, s.user_id, s.token_hash, coalesce(s.idp_sid, ''), s.idp_client_id,
	s.idp_checked_at, s.created_at, s.last_seen_at, s.user_agent, coalesce(host(s.ip), ''), s.auth_time,
	s.platform, s.device_name, s.app_version`

func scanSession(row pgx.Row) (Session, error) {
	var x Session
	var authTime *time.Time
	err := row.Scan(&x.ID, &x.TenantID, &x.UserID, &x.TokenHash, &x.IdPSID, &x.IdPClientID,
		&x.IdPCheckedAt, &x.CreatedAt, &x.LastSeenAt, &x.UserAgent, &x.IP, &authTime,
		&x.Platform, &x.DeviceName, &x.AppVersion)
	if authTime != nil {
		x.AuthTime = *authTime
	}
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
	// AuthTime is the ID token's auth_time; zero when it had none.
	AuthTime time.Time
	// Platform is PlatformWeb (the zero value is stored as web too),
	// PlatformIOS or PlatformAndroid; DeviceName and AppVersion come from a
	// native app.
	Platform   int16
	DeviceName string
	AppVersion string
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
	var authTime *time.Time
	if !n.AuthTime.IsZero() {
		authTime = &n.AuthTime
	}
	platform := n.Platform
	if platform == 0 {
		platform = PlatformWeb
	}
	var id int64
	err := s.pool.QueryRow(ctx, `
		INSERT INTO user_sessions (token_hash, tenant_id, user_id, idp_sid, idp_client_id,
			refresh_token_enc, id_token_enc, user_agent, ip, auth_time, platform, device_name, app_version)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::inet, $10, $11, $12, $13)
		RETURNING id`,
		n.TokenHash, n.TenantID, n.UserID, sid, n.IdPClientID, n.RefreshTokenEnc, n.IDTokenEnc, n.UserAgent, ip,
		authTime, platform, n.DeviceName, n.AppVersion).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("store: create session: %w", err)
	}
	return id, nil
}

// ActiveSession returns the usable session whose token hashes to tokenHash,
// with the deletion lock of its account. A session of an erased account is
// never usable.
func (s *Store) ActiveSession(ctx context.Context, tenantID string, tokenHash []byte) (Session, error) {
	var x Session
	var authTime *time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT `+sessionColumns+`, u.deletion_requested_at IS NOT NULL FROM user_sessions s JOIN users u ON u.id = s.user_id
		WHERE s.tenant_id = $1 AND s.token_hash = $2 AND u.deleted_at IS NULL AND `+activeSession,
		tenantID, tokenHash).Scan(&x.ID, &x.TenantID, &x.UserID, &x.TokenHash, &x.IdPSID, &x.IdPClientID,
		&x.IdPCheckedAt, &x.CreatedAt, &x.LastSeenAt, &x.UserAgent, &x.IP, &authTime,
		&x.Platform, &x.DeviceName, &x.AppVersion, &x.AccountLocked)
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, ErrNotFound
	}
	if err != nil {
		return Session{}, fmt.Errorf("store: active session: %w", err)
	}
	if authTime != nil {
		x.AuthTime = *authTime
	}
	return x, nil
}

// SessionStatus is what TouchSession found out about a session.
type SessionStatus struct {
	// Active: not revoked, not idle past SessionIdleTimeout, younger than
	// SessionMaxAge.
	Active bool
	// RevokeReason of a revoked session (user_sessions.revoke_reason, an
	// app.v1.SessionRevokeReason); 0 when not revoked or unknown.
	RevokeReason int16
}

// TouchSession moves last_seen_at of an active session to now when it is
// older than minInterval, and reports whether the session is still active
// (a missing session is inactive). A session whose row is locked by a
// concurrent write is not touched rather than waited on; the next call
// touches it.
func (s *Store) TouchSession(ctx context.Context, id int64, minInterval time.Duration) (SessionStatus, error) {
	var st SessionStatus
	var reason *int16
	err := s.pool.QueryRow(ctx, `
		WITH touched AS (
			UPDATE user_sessions SET last_seen_at = now()
			WHERE id = (SELECT s.id FROM user_sessions s
				WHERE s.id = $1 AND `+activeSession+` AND s.last_seen_at < now() - $2::interval
				FOR UPDATE SKIP LOCKED)
			RETURNING id)
		SELECT `+activeSession+`, s.revoke_reason FROM user_sessions s WHERE s.id = $1`,
		id, minInterval).Scan(&st.Active, &reason)
	if errors.Is(err, pgx.ErrNoRows) {
		return SessionStatus{}, nil
	}
	if err != nil {
		return SessionStatus{}, fmt.Errorf("store: touch session: %w", err)
	}
	if reason != nil {
		st.RevokeReason = *reason
	}
	return st, nil
}

// ListActiveSessions returns the usable sessions of a user, the most
// recently active first (as Telegram lists devices).
func (s *Store) ListActiveSessions(ctx context.Context, tenantID string, userID int64) ([]Session, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+sessionColumns+` FROM user_sessions s
		WHERE s.tenant_id = $1 AND s.user_id = $2 AND `+activeSession+`
		ORDER BY s.last_seen_at DESC, s.id DESC`,
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
	// IdPClientID is the IdP client the refresh token was issued to.
	IdPClientID string
}

func collectRevoked(rows pgx.Rows) ([]RevokedSession, error) {
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (RevokedSession, error) {
		var r RevokedSession
		err := row.Scan(&r.ID, &r.TokenHash, &r.RefreshTokenEnc, &r.IdPClientID)
		return r, err
	})
}

// RevokeSession revokes one active session of the user; ErrNotFound when the
// user has no such active session. callerTokenHash is the token hash of the
// session making the request (nil when unknown): revoking it is a sign-out.
// Its ID token is kept only when keepIDToken (a web session signing out
// through its cookie), for the SignOut then /auth/logout flow.
func (s *Store) RevokeSession(ctx context.Context, tenantID string, userID, sessionID int64, callerTokenHash []byte, keepIDToken bool) (RevokedSession, error) {
	rows, err := s.pool.Query(ctx, `
		WITH target AS (
			SELECT s.id, s.token_hash, s.refresh_token_enc FROM user_sessions s
			WHERE s.tenant_id = $1 AND s.user_id = $2 AND s.id = $3 AND `+activeSession+`
			FOR UPDATE)
		UPDATE user_sessions u SET revoked_at = now(), refresh_token_enc = NULL,
			id_token_enc = CASE WHEN u.token_hash = $4 AND $5 THEN u.id_token_enc END,
			revoke_reason = CASE WHEN u.token_hash = $4 THEN `+reasonSignedOut+` ELSE `+reasonRevokedByUser+` END
		FROM target WHERE u.id = target.id
		RETURNING u.id, target.token_hash, target.refresh_token_enc, u.idp_client_id`,
		tenantID, userID, sessionID, callerTokenHash, keepIDToken)
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
		RETURNING u.id, target.token_hash, target.refresh_token_enc, u.idp_client_id`,
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

// RevokeAllSessions revokes every session of the user that is not revoked
// yet (expired ones too, so a native refresh token still held is revoked at
// the IdP) because the account entered its deletion grace period.
func (s *Store) RevokeAllSessions(ctx context.Context, tenantID string, userID int64) ([]RevokedSession, error) {
	rows, err := s.pool.Query(ctx, `
		WITH target AS (
			SELECT s.id, s.token_hash, s.refresh_token_enc FROM user_sessions s
			WHERE s.tenant_id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL
			FOR UPDATE)
		UPDATE user_sessions u SET revoked_at = now(), refresh_token_enc = NULL, id_token_enc = NULL,
			revoke_reason = `+reasonAccountDeleted+`
		FROM target WHERE u.id = target.id
		RETURNING u.id, target.token_hash, target.refresh_token_enc, u.idp_client_id`,
		tenantID, userID)
	if err != nil {
		return nil, fmt.Errorf("store: revoke all sessions: %w", err)
	}
	list, err := collectRevoked(rows)
	if err != nil {
		return nil, fmt.Errorf("store: revoke all sessions: %w", err)
	}
	return list, nil
}

// ReplacedSession is a session revoked because the browser holding it signed
// in again: its sealed refresh token for the IdP revocation, and the owner
// and IdP session the caller compares with the new session.
type ReplacedSession struct {
	RevokedSession
	UserID int64
	IdPSID string
}

// ReplaceSession revokes the active session whose token hashes to tokenHash,
// unless it is newID (the session that replaces it), and clears its sealed
// tokens. ErrNotFound when no such active session exists.
func (s *Store) ReplaceSession(ctx context.Context, tenantID string, tokenHash []byte, newID int64) (ReplacedSession, error) {
	var r ReplacedSession
	err := s.pool.QueryRow(ctx, `
		WITH target AS (
			SELECT s.id, s.token_hash, s.refresh_token_enc, s.user_id, coalesce(s.idp_sid, '') AS idp_sid, s.idp_client_id FROM user_sessions s
			WHERE s.tenant_id = $1 AND s.token_hash = $2 AND s.id <> $3 AND `+activeSession+`
			FOR UPDATE)
		UPDATE user_sessions u SET revoked_at = now(), refresh_token_enc = NULL, id_token_enc = NULL,
			revoke_reason = `+reasonReplaced+`
		FROM target WHERE u.id = target.id
		RETURNING u.id, target.token_hash, target.refresh_token_enc, target.user_id, target.idp_sid, target.idp_client_id`,
		tenantID, tokenHash, newID).Scan(&r.ID, &r.TokenHash, &r.RefreshTokenEnc, &r.UserID, &r.IdPSID, &r.IdPClientID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ReplacedSession{}, ErrNotFound
	}
	if err != nil {
		return ReplacedSession{}, fmt.Errorf("store: replace session: %w", err)
	}
	return r, nil
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
		RETURNING u.id, target.token_hash, target.refresh_token_enc, target.id_token_enc, u.idp_client_id`,
		tenantID, tokenHash).Scan(&r.ID, &r.TokenHash, &r.RefreshTokenEnc, &r.IDTokenEnc, &r.IdPClientID)
	if errors.Is(err, pgx.ErrNoRows) {
		return RevokedSession{}, ErrNotFound
	}
	if err != nil {
		return RevokedSession{}, fmt.Errorf("store: end session for logout: %w", err)
	}
	return r, nil
}

// BackchannelLogout records the logout token's jti and, when it was not seen
// before, revokes the sessions of the IdP client (the token's aud) that carry
// sid. Without a sid the IdP ended everything of the subject, so every
// session of the IdP subject is revoked, of any client (web and native app).
// A sid names one IdP browser session: it ends only that client's sessions,
// so signing out of the IdP in a browser leaves the native app's per-device
// grant alone (ADR 0006, ADR 0011). Both happen in one transaction so a
// failed revocation can be retried by the IdP. fresh is false for a replay.
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
				WHERE u.id = s.user_id AND u.tenant_id = $1 AND u.idp_sub = $2
					AND s.tenant_id = $1 AND s.revoked_at IS NULL`,
				tenantID, sub)
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
