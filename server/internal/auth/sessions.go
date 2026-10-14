package auth

import (
	"context"
	"crypto/subtle"
	"errors"
	"log/slog"
	"sync"
	"time"

	"app.local/server/internal/sealbox"
	"app.local/server/internal/store"
)

// ErrNoSession reports a missing, unknown, revoked or expired session token.
var ErrNoSession = errors.New("auth: no valid session")

// Session timing (ADR 0006).
const (
	// GrantCheckInterval: a used session refreshes its IdP grant at most
	// this often.
	GrantCheckInterval = time.Hour
	// grantRetryAfter: after an IdP outage the check is retried this much
	// later instead of on every request.
	grantRetryAfter = 5 * time.Minute
	// touchInterval: last_seen_at is written at most this often.
	touchInterval = time.Minute
	// backgroundTimeout bounds one background IdP call.
	backgroundTimeout = 20 * time.Second
)

// Sessions issues and checks chat sessions of one tenant and keeps them
// bound to the IdP grant.
type Sessions struct {
	store    *store.Store
	idp      *IdP
	refresh  *sealbox.Box
	idTokens *sealbox.Box
	tenantID string
	logger   *slog.Logger

	wg       sync.WaitGroup
	mu       sync.Mutex
	checking map[int64]struct{}
}

// NewSessions builds the manager. sessionKey is SESSION_KEY.
func NewSessions(st *store.Store, idp *IdP, sessionKey []byte, tenantID string, logger *slog.Logger) (*Sessions, error) {
	refresh, err := sealbox.New(sessionKey, "idp refresh token")
	if err != nil {
		return nil, err
	}
	idTokens, err := sealbox.New(sessionKey, "idp id token")
	if err != nil {
		return nil, err
	}
	return &Sessions{
		store: st, idp: idp, refresh: refresh, idTokens: idTokens,
		tenantID: tenantID, logger: logger, checking: map[int64]struct{}{},
	}, nil
}

// Wait blocks until background grant checks and IdP revocations finish.
func (m *Sessions) Wait() {
	m.wg.Wait()
}

func (m *Sessions) background(fn func(ctx context.Context)) {
	m.wg.Go(func() {
		ctx, cancel := context.WithTimeout(context.Background(), backgroundTimeout)
		defer cancel()
		fn(ctx)
	})
}

// NewSessionData is what sign-in learned about the new session.
type NewSessionData struct {
	UserID       int64
	IdPSID       string
	RefreshToken string // may be empty
	IDToken      string
	UserAgent    string
	IP           string
}

// Create issues a session and returns its opaque token (only its hash is
// stored). The IdP tokens are sealed and bound to that hash.
func (m *Sessions) Create(ctx context.Context, d NewSessionData) (token string, id int64, err error) {
	token = newSecret(sessionTokenBytes)
	hash, _ := hashToken(token)
	var refreshEnc []byte
	if d.RefreshToken != "" {
		refreshEnc = m.refresh.Seal([]byte(d.RefreshToken), hash)
	}
	id, err = m.store.CreateSession(ctx, store.NewSession{
		TokenHash:       hash,
		TenantID:        m.tenantID,
		UserID:          d.UserID,
		IdPSID:          d.IdPSID,
		IdPClientID:     m.idp.ClientID(),
		RefreshTokenEnc: refreshEnc,
		IDTokenEnc:      m.idTokens.Seal([]byte(d.IDToken), hash),
		UserAgent:       truncate(d.UserAgent, 512),
		IP:              d.IP,
	})
	if err != nil {
		return "", 0, err
	}
	return token, id, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// Authenticate resolves a session token. It also records activity (at most
// once a minute) and, when the last grant check is an hour old, starts one
// in the background so the request is not delayed by the IdP.
func (m *Sessions) Authenticate(ctx context.Context, token string) (store.Session, error) {
	hash, ok := hashToken(token)
	if !ok {
		return store.Session{}, ErrNoSession
	}
	s, err := m.store.ActiveSession(ctx, m.tenantID, hash)
	if errors.Is(err, store.ErrNotFound) {
		return store.Session{}, ErrNoSession
	}
	if err != nil {
		return store.Session{}, err
	}
	// The lookup is by hash; compare again in constant time anyway.
	if subtle.ConstantTimeCompare(s.TokenHash, hash) != 1 {
		return store.Session{}, ErrNoSession
	}
	now := time.Now()
	if now.Sub(s.LastSeenAt) >= touchInterval {
		if err := m.store.TouchSession(ctx, s.ID, touchInterval); err != nil {
			m.logger.Warn("touch session failed", "session_id", s.ID, "err", err)
		}
	}
	if now.Sub(s.IdPCheckedAt) >= GrantCheckInterval {
		m.scheduleGrantCheck(s.ID)
	}
	return s, nil
}

// scheduleGrantCheck starts a background grant check unless one is already
// running for the session in this process. Across processes the row lock in
// store.CheckGrant keeps checks exclusive.
func (m *Sessions) scheduleGrantCheck(sessionID int64) {
	m.mu.Lock()
	if _, busy := m.checking[sessionID]; busy {
		m.mu.Unlock()
		return
	}
	m.checking[sessionID] = struct{}{}
	m.mu.Unlock()
	m.background(func(ctx context.Context) {
		defer func() {
			m.mu.Lock()
			delete(m.checking, sessionID)
			m.mu.Unlock()
		}()
		if _, err := m.CheckGrant(ctx, sessionID); err != nil {
			m.logger.Error("grant check failed", "session_id", sessionID, "err", err)
		}
	})
}

// CheckGrant refreshes the session's IdP grant when its last check is at
// least GrantCheckInterval old: invalid_grant revokes the session, IdP
// outages keep it and retry later, success stores the rotated tokens and the
// email the IdP reports. ran reports whether the IdP was consulted.
func (m *Sessions) CheckGrant(ctx context.Context, sessionID int64) (ran bool, err error) {
	return m.store.CheckGrant(ctx, sessionID, GrantCheckInterval, m.checkGrant)
}

func (m *Sessions) checkGrant(ctx context.Context, c store.GrantCandidate) store.GrantOutcome {
	log := m.logger.With("session_id", c.SessionID)
	if c.RefreshTokenEnc == nil {
		// Nothing to refresh; back-channel logout still ends the session.
		return store.GrantOutcome{Result: store.GrantAlive}
	}
	rt, err := m.refresh.Open(c.RefreshTokenEnc, c.TokenHash)
	if err != nil {
		// Sealed with another SESSION_KEY: the grant can no longer be proven.
		log.Warn("stored refresh token cannot be opened; revoking session")
		return store.GrantOutcome{Result: store.GrantEnded}
	}
	tokens, err := m.idp.Refresh(ctx, string(rt))
	switch {
	case errors.Is(err, ErrGrantEnded):
		log.Info("IdP grant ended; session revoked")
		return store.GrantOutcome{Result: store.GrantEnded}
	case err != nil:
		log.Warn("IdP refresh failed; session kept", "retry_in", grantRetryAfter, "err", err)
		return store.GrantOutcome{Result: store.GrantRetry, RetryAfter: grantRetryAfter}
	}
	out := store.GrantOutcome{Result: store.GrantAlive}
	if tokens.RefreshToken != "" {
		out.RefreshTokenEnc = m.refresh.Seal([]byte(tokens.RefreshToken), c.TokenHash)
	}
	if tokens.IDToken != "" {
		out.IDTokenEnc = m.idTokens.Seal([]byte(tokens.IDToken), c.TokenHash)
	}
	if tokens.Claims.Subject != "" {
		if tokens.Claims.Subject != c.IdPSub {
			log.Error("IdP refresh returned another subject; session revoked")
			return store.GrantOutcome{Result: store.GrantEnded}
		}
		out.Email = &store.IdPEmail{Email: tokens.Claims.Email, Verified: tokens.Claims.EmailVerified}
	}
	return out
}

// Revoke revokes one session of the user and, in the background, its IdP
// refresh token. store.ErrNotFound when the user has no such session.
func (m *Sessions) Revoke(ctx context.Context, userID, sessionID int64) error {
	r, err := m.store.RevokeSession(ctx, m.tenantID, userID, sessionID)
	if err != nil {
		return err
	}
	m.revokeAtIdP([]store.RevokedSession{r})
	return nil
}

// RevokeOthers revokes every other session of the user and returns how many.
func (m *Sessions) RevokeOthers(ctx context.Context, userID, keepID int64) (int, error) {
	list, err := m.store.RevokeOtherSessions(ctx, m.tenantID, userID, keepID)
	if err != nil {
		return 0, err
	}
	m.revokeAtIdP(list)
	return len(list), nil
}

// EndForLogout ends the session of token for RP-initiated logout and returns
// the ID token to send as id_token_hint ("" when none is left). ErrNoSession
// when the token matches no session.
func (m *Sessions) EndForLogout(ctx context.Context, token string) (idTokenHint string, err error) {
	hash, ok := hashToken(token)
	if !ok {
		return "", ErrNoSession
	}
	r, err := m.store.EndSessionForLogout(ctx, m.tenantID, hash)
	if errors.Is(err, store.ErrNotFound) {
		return "", ErrNoSession
	}
	if err != nil {
		return "", err
	}
	m.revokeAtIdP([]store.RevokedSession{r})
	if r.IDTokenEnc == nil {
		return "", nil
	}
	plain, err := m.idTokens.Open(r.IDTokenEnc, r.TokenHash)
	if err != nil {
		m.logger.Warn("stored ID token cannot be opened; logging out without id_token_hint", "session_id", r.ID)
		return "", nil
	}
	return string(plain), nil
}

// revokeAtIdP revokes the refresh tokens of just-revoked sessions at the IdP
// in the background (best effort; failures are logged without the token).
func (m *Sessions) revokeAtIdP(list []store.RevokedSession) {
	var tokens []string
	for _, r := range list {
		if r.RefreshTokenEnc == nil {
			continue
		}
		rt, err := m.refresh.Open(r.RefreshTokenEnc, r.TokenHash)
		if err != nil {
			m.logger.Warn("stored refresh token cannot be opened; not revoked at IdP", "session_id", r.ID)
			continue
		}
		tokens = append(tokens, string(rt))
	}
	if len(tokens) == 0 {
		return
	}
	m.background(func(ctx context.Context) {
		for _, rt := range tokens {
			if err := m.idp.Revoke(ctx, rt); err != nil {
				m.logger.Warn("IdP token revocation failed", "err", err)
			}
		}
	})
}
