package auth

import (
	"context"
	"crypto/subtle"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"app.local/server/internal/sealbox"
	"app.local/server/internal/store"
	"connectrpc.com/connect"
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
	// backgroundTimeout bounds one background task: a grant check up to its
	// IdP answer, or the IdP revocations after a sign-out. The outcome of a
	// grant check is then written within store.GrantWriteTimeout even when
	// this deadline has passed.
	backgroundTimeout = 20 * time.Second
	// orphanRevokeTimeout bounds revoking, at the end of a grant check, a
	// refresh token that will not be stored.
	orphanRevokeTimeout = 5 * time.Second
	// maxGrantChecks bounds the grant checks running at once in this
	// process.
	maxGrantChecks = 4
	// maxStoredTextBytes bounds request text stored with a session.
	maxStoredTextBytes = 512
)

// ShutdownBudget is the longest a graceful stop of the api role can take
// once the HTTP server has drained: a grant check that starts at the end of
// the drain waits for the IdP (backgroundTimeout), writes its outcome
// (store.GrantWriteTimeout) and may revoke a token it could not store
// (orphanRevokeTimeout).
const ShutdownBudget = backgroundTimeout + store.GrantWriteTimeout + orphanRevokeTimeout

// Sessions issues and checks chat sessions of one tenant and keeps them
// bound to the IdP grant.
type Sessions struct {
	store    *store.Store
	idp      *IdP
	refresh  *sealbox.Box
	idTokens *sealbox.Box
	tenantID string
	logger   *slog.Logger

	// grantSlots holds one token per running grant check.
	grantSlots chan struct{}

	mu       sync.Mutex
	idle     *sync.Cond // broadcast when running drops to zero
	running  int        // background tasks in flight
	checking map[int64]struct{}
}

// NewSessions builds the manager. sessionKey is SESSION_KEY and
// previousKey SESSION_KEY_PREVIOUS (nil when unset).
func NewSessions(st *store.Store, idp *IdP, sessionKey, previousKey []byte, tenantID string, logger *slog.Logger) (*Sessions, error) {
	refresh, idTokens, err := sessionBoxes(sessionKey, previousKey)
	if err != nil {
		return nil, err
	}
	m := &Sessions{
		store: st, idp: idp, refresh: refresh, idTokens: idTokens,
		tenantID: tenantID, logger: logger,
		grantSlots: make(chan struct{}, maxGrantChecks),
		checking:   map[int64]struct{}{},
	}
	m.idle = sync.NewCond(&m.mu)
	return m, nil
}

// Wait blocks until no background grant check or IdP revocation is in
// flight, including tasks started while it waits; each task ends within
// ShutdownBudget. Call it after the HTTP server has drained and before the
// store is closed, so a refresh token the IdP already rotated is stored.
func (m *Sessions) Wait() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for m.running > 0 {
		m.idle.Wait()
	}
}

func (m *Sessions) background(fn func(ctx context.Context)) {
	m.mu.Lock()
	m.running++
	m.mu.Unlock()
	go func() {
		defer func() {
			m.mu.Lock()
			m.running--
			if m.running == 0 {
				m.idle.Broadcast()
			}
			m.mu.Unlock()
		}()
		ctx, cancel := context.WithTimeout(context.Background(), backgroundTimeout)
		defer cancel()
		fn(ctx)
	}()
}

// NewSessionData is what sign-in learned about the new session.
type NewSessionData struct {
	UserID       int64
	IdPSID       string
	RefreshToken string // may be empty
	IDToken      string
	UserAgent    string
	IP           string
	// AuthTime is the ID token's auth_time; zero when unknown.
	AuthTime time.Time
	// Native is set for a session of the iOS or Android app: its IdP tokens
	// belong to MobileClientID and it authenticates with the Authorization
	// header. Nil for a web session.
	Native *NativeDevice
}

// NativeDevice is what a native app says about itself at sign-in.
type NativeDevice struct {
	// Platform is store.PlatformIOS or store.PlatformAndroid.
	Platform   int16
	DeviceName string
	AppVersion string
}

// maxDeviceTextBytes bounds the device name and app version of a native
// session.
const maxDeviceTextBytes = 128

// Create issues a session and returns its opaque token (only its hash is
// stored). The IdP tokens are sealed and bound to that hash.
func (m *Sessions) Create(ctx context.Context, d NewSessionData) (token string, id int64, err error) {
	token = newSecret(sessionTokenBytes)
	hash, _ := hashToken(token)
	var refreshEnc []byte
	if d.RefreshToken != "" {
		refreshEnc = m.refresh.Seal([]byte(d.RefreshToken), hash)
	}
	n := store.NewSession{
		TokenHash:       hash,
		TenantID:        m.tenantID,
		UserID:          d.UserID,
		IdPSID:          d.IdPSID,
		IdPClientID:     m.idp.ClientID(),
		RefreshTokenEnc: refreshEnc,
		IDTokenEnc:      m.idTokens.Seal([]byte(d.IDToken), hash),
		UserAgent:       truncate(d.UserAgent, maxStoredTextBytes),
		IP:              d.IP,
		AuthTime:        d.AuthTime,
		Platform:        store.PlatformWeb,
	}
	if d.Native != nil {
		if d.Native.Platform != store.PlatformIOS && d.Native.Platform != store.PlatformAndroid {
			return "", 0, errors.New("auth: a native session needs the iOS or Android platform")
		}
		n.IdPClientID = MobileClientID
		n.Platform = d.Native.Platform
		n.DeviceName = truncate(d.Native.DeviceName, maxDeviceTextBytes)
		n.AppVersion = truncate(d.Native.AppVersion, maxDeviceTextBytes)
	}
	id, err = m.store.CreateSession(ctx, n)
	if err != nil {
		return "", 0, err
	}
	return token, id, nil
}

// truncate returns s as valid UTF-8 without NUL bytes (PostgreSQL text
// rejects both) and at most n bytes long, cut at a rune boundary.
func truncate(s string, n int) string {
	s = strings.ReplaceAll(strings.ToValidUTF8(s, "\uFFFD"), "\x00", "")
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// AuthenticateBearer resolves a session token sent in the Authorization
// header (or the first WebSocket frame) like Authenticate, but accepts only
// native app sessions: a web session's token lives in an HttpOnly cookie and
// is never valid as a bearer token.
func (m *Sessions) AuthenticateBearer(ctx context.Context, token string) (store.Session, error) {
	s, err := m.Authenticate(ctx, token)
	if err != nil {
		return store.Session{}, err
	}
	if !s.Native() {
		return store.Session{}, ErrNoSession
	}
	return s, nil
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
		if _, err := m.store.TouchSession(ctx, s.ID, touchInterval); err != nil {
			m.logger.Warn("touch session failed", "session_id", s.ID, "err", err)
		}
	}
	if now.Sub(s.IdPCheckedAt) >= GrantCheckInterval {
		m.scheduleGrantCheck(s.ID)
	}
	return s, nil
}

// scheduleGrantCheck starts a background grant check unless one is already
// running for the session in this process or every grant check slot is busy
// (the next request of the session schedules it again). Across processes
// the lease in store.CheckGrant keeps checks exclusive.
func (m *Sessions) scheduleGrantCheck(sessionID int64) {
	m.mu.Lock()
	if _, busy := m.checking[sessionID]; busy {
		m.mu.Unlock()
		return
	}
	select {
	case m.grantSlots <- struct{}{}:
	default:
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
			<-m.grantSlots
		}()
		if _, err := m.runGrantCheck(ctx, sessionID); err != nil {
			m.logger.Error("grant check failed", "session_id", sessionID, "err", err)
		}
	})
}

// CheckGrant refreshes the session's IdP grant when its last check is at
// least GrantCheckInterval old: invalid_grant revokes the session, IdP
// outages keep it and retry later, success stores the rotated tokens and the
// email the IdP reports. It waits for a free grant check slot. ran reports
// whether the IdP was consulted.
func (m *Sessions) CheckGrant(ctx context.Context, sessionID int64) (ran bool, err error) {
	select {
	case m.grantSlots <- struct{}{}:
	case <-ctx.Done():
		return false, ctx.Err()
	}
	defer func() { <-m.grantSlots }()
	return m.runGrantCheck(ctx, sessionID)
}

func (m *Sessions) runGrantCheck(ctx context.Context, sessionID int64) (ran bool, err error) {
	var (
		result   store.GrantResult
		held     string // refresh token in hand after the IdP answered
		clientID string // IdP client of held
	)
	ran, err = m.store.CheckGrant(ctx, sessionID, GrantCheckInterval, func(ctx context.Context, c store.GrantCandidate) store.GrantOutcome {
		out, rt := m.refreshGrant(ctx, c)
		result, held, clientID = out.Result, rt, c.IdPClientID
		return out
	})
	notApplied := errors.Is(err, store.ErrGrantNotApplied)
	if notApplied {
		m.logger.Info("session revoked during its grant check; outcome dropped", "session_id", sessionID)
		err = nil
	}
	// A live refresh token that is not kept would leave the grant open at
	// the IdP with nobody able to end it.
	if held != "" && (notApplied || result == store.GrantEnded) {
		rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), orphanRevokeTimeout)
		defer cancel()
		if rerr := m.idp.Revoke(rctx, clientID, held); rerr != nil {
			m.logger.Warn("IdP revocation of an unstored refresh token failed", "session_id", sessionID, "err", rerr)
		}
	}
	return ran, err
}

// refreshGrant consults the IdP for one claimed session. It also returns
// the refresh token the IdP handed back ("" when the token endpoint did not
// succeed), which the caller revokes if it is not stored.
func (m *Sessions) refreshGrant(ctx context.Context, c store.GrantCandidate) (store.GrantOutcome, string) {
	log := m.logger.With("session_id", c.SessionID)
	if c.RefreshTokenEnc == nil {
		// Nothing to refresh; back-channel logout still ends the session.
		return store.GrantOutcome{Result: store.GrantAlive}, ""
	}
	rt, err := m.refresh.Open(c.RefreshTokenEnc, c.TokenHash)
	if err != nil {
		// Sealed with another SESSION_KEY: the grant can no longer be proven.
		log.Warn("stored refresh token cannot be opened; revoking session")
		return store.GrantOutcome{Result: store.GrantEnded}, ""
	}
	tokens, err := m.idp.Refresh(ctx, c.IdPClientID, string(rt))
	retry := store.GrantOutcome{Result: store.GrantRetry, RetryAfter: grantRetryAfter}
	switch {
	case errors.Is(err, ErrGrantEnded):
		log.Info("IdP grant ended; session revoked")
		return store.GrantOutcome{Result: store.GrantEnded}, ""
	case errors.Is(err, ErrRefreshRejected):
		log.Error("IdP rejected the refresh request; check the OIDC client registration and secret",
			"retry_in", grantRetryAfter, "err", err)
		return retry, ""
	case err != nil:
		log.Warn("IdP refresh failed; session kept", "retry_in", grantRetryAfter, "err", err)
		return retry, ""
	}
	out := store.GrantOutcome{Result: store.GrantAlive}
	// oauth2 hands back the sent refresh token when the IdP keeps it, so a
	// successful check also moves a token sealed under SESSION_KEY_PREVIOUS
	// to SESSION_KEY.
	if tokens.RefreshToken != "" {
		out.RefreshTokenEnc = m.refresh.Seal([]byte(tokens.RefreshToken), c.TokenHash)
	}
	if tokens.ClaimsErr != nil {
		// The IdP already rotated the refresh token: store it, keep the email.
		log.Warn("IdP refresh claims could not be verified; tokens rotated, profile unchanged", "err", tokens.ClaimsErr)
		return out, tokens.RefreshToken
	}
	if tokens.IDToken != "" {
		out.IDTokenEnc = m.idTokens.Seal([]byte(tokens.IDToken), c.TokenHash)
	}
	if tokens.Claims.Subject != "" {
		if tokens.Claims.Subject != c.IdPSub {
			log.Error("IdP refresh returned another subject; session revoked")
			return store.GrantOutcome{Result: store.GrantEnded}, tokens.RefreshToken
		}
		profile := tokens.Claims.idpProfile()
		out.Profile = &profile
	}
	return out, tokens.RefreshToken
}

// Revoke revokes one session of the user and, in the background, its IdP
// refresh token. store.ErrNotFound when the user has no such session. When
// ctx is an RPC whose session cookie is the revoked session itself (SignOut)
// its ID token is kept for /auth/logout; revoked from another session, or a
// native session signing out with its bearer token (it has no
// /auth/logout), the ID token is erased too.
func (m *Sessions) Revoke(ctx context.Context, userID, sessionID int64) error {
	hash, cookie := callerTokenHash(ctx)
	r, err := m.store.RevokeSession(ctx, m.tenantID, userID, sessionID, hash, cookie)
	if err != nil {
		return err
	}
	m.revokeAtIdP([]store.RevokedSession{r})
	return nil
}

// Replace revokes the session the browser held when it started a sign-in
// (replacedHash, carried by the login cookie) now that session newID of
// userID, bound to IdP session idpSID, replaces it. Nothing happens when that
// session is no longer active. Its refresh token is revoked at the IdP only
// when the two sessions cannot share one IdP grant: the IdP extends the grant
// of its browser session on every sign-in, and revoking a refresh token may
// end the whole grant, the new session's included. A token left unrevoked is
// erased here and expires with the grant.
//
// An unknown sid (either side) counts as a shared grant on purpose. The IdP
// registers chat-web with backchannel_logout_session_required, so its ID
// tokens always carry sid; an empty one means a session stored without it,
// and nothing then proves the grants differ. Revoking would risk signing the
// new session out at its next grant check, while the old token, erased here,
// can no longer be presented by this server and lives no longer than the IdP
// session it belongs to.
func (m *Sessions) Replace(ctx context.Context, replacedHash []byte, newID, userID int64, idpSID string) error {
	r, err := m.store.ReplaceSession(ctx, m.tenantID, replacedHash, newID)
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	sharedGrant := r.UserID == userID && (r.IdPSID == "" || idpSID == "" || r.IdPSID == idpSID)
	if !sharedGrant {
		m.revokeAtIdP([]store.RevokedSession{r.RevokedSession})
	}
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

// RevokeAll revokes every session of the user (the account entered its
// deletion grace period) and, in the background, their IdP refresh tokens,
// which ends the app's grants at the IdP. It returns how many.
func (m *Sessions) RevokeAll(ctx context.Context, userID int64) (int, error) {
	list, err := m.store.RevokeAllSessions(ctx, m.tenantID, userID)
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

// callerTokenHash returns the token hash of the session the RPC that ctx
// belongs to authenticated with (RequestToken), and whether it came from the
// cookie; nil outside an RPC or without a well-formed token.
func callerTokenHash(ctx context.Context) (hash []byte, cookie bool) {
	info, ok := connect.CallInfoForHandlerContext(ctx)
	if !ok {
		return nil, false
	}
	token, bearer := RequestToken(info.RequestHeader(), false)
	hash, ok = hashToken(token)
	if !ok {
		return nil, false
	}
	return hash, !bearer
}

// revokeAtIdP revokes the refresh tokens of just-revoked sessions at the IdP
// in the background (best effort; failures are logged without the token).
func (m *Sessions) revokeAtIdP(list []store.RevokedSession) {
	type grant struct{ clientID, token string }
	var tokens []grant
	for _, r := range list {
		if r.RefreshTokenEnc == nil {
			continue
		}
		rt, err := m.refresh.Open(r.RefreshTokenEnc, r.TokenHash)
		if err != nil {
			m.logger.Warn("stored refresh token cannot be opened; not revoked at IdP", "session_id", r.ID)
			continue
		}
		tokens = append(tokens, grant{clientID: r.IdPClientID, token: string(rt)})
	}
	if len(tokens) == 0 {
		return
	}
	m.background(func(ctx context.Context) {
		for _, g := range tokens {
			if err := m.idp.Revoke(ctx, g.clientID, g.token); err != nil {
				m.logger.Warn("IdP token revocation failed", "err", err)
			}
		}
	})
}
