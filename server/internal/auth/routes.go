package auth

import (
	"context"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"time"

	"app.local/server/internal/ratelimit"
	"app.local/server/internal/sealbox"
	"app.local/server/internal/store"
	"golang.org/x/oauth2"
)

// logoutJTITTL keeps processed logout token ids well past their 2 minute
// validity.
const logoutJTITTL = 10 * time.Minute

// callbackTimeout bounds the code exchange and account setup of a callback.
const callbackTimeout = 30 * time.Second

// replaceTimeout bounds revoking the session a sign-in replaces, which runs
// after the response was sent.
const replaceTimeout = 10 * time.Second

// maxBackchannelBody bounds the back-channel logout form.
const maxBackchannelBody = 64 << 10

// supportedLocales maps accepted ?locale= values (lowercase) to the
// ui_locales tags the IdP serves.
var supportedLocales = map[string]string{"en": "en", "vi": "vi", "zh-cn": "zh-CN"}

// RoutesConfig wires the web sign-in routes.
type RoutesConfig struct {
	IdP          *IdP
	Sessions     *Sessions
	Store        *store.Store
	Origins      *Origins
	TenantID     string
	PublicOrigin string // e.g. https://chat.hoandat.com
	SessionKey   []byte
	// SessionKeyPrevious still opens login cookies sealed before a rotation.
	SessionKeyPrevious []byte
	Logger             *slog.Logger
	// Limiter and the Signups* caps limit the chat accounts first sign-ins
	// create, per client address in an hour and per tenant in ten minutes;
	// a nil Limiter or a 0 cap turns that limit off.
	Limiter          ratelimit.Limiter
	SignupsPerIPHour int
	SignupsPer10Min  int
}

// Routes serves /auth/login, /auth/callback, /auth/logout and
// /auth/backchannel-logout.
type Routes struct {
	cfg   RoutesConfig
	login *sealbox.Box
	now   func() time.Time
}

// NewRoutes builds the handlers.
func NewRoutes(cfg RoutesConfig) (*Routes, error) {
	box, err := sealbox.New(cfg.SessionKey, "login cookie", cfg.SessionKeyPrevious)
	if err != nil {
		return nil, err
	}
	return &Routes{cfg: cfg, login: box, now: time.Now}, nil
}

// Register adds the routes to mux.
func (h *Routes) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /auth/login", h.handleLogin)
	mux.HandleFunc("GET /auth/callback", h.handleCallback)
	mux.HandleFunc("POST /auth/logout", h.handleLogout)
	mux.HandleFunc("POST /auth/backchannel-logout", h.handleBackchannelLogout)
}

// handleLogin starts Code + PKCE: ?locale= becomes ui_locales,
// ?prompt=create opens the IdP sign-up page, ?reauth=1 makes the IdP ask
// for the credentials again (prompt=login, max_age; the new session then
// has a recent auth_time for ADR 0006 sensitive actions), and ?return_to= (a same-origin
// path, CleanReturnTo; anything else is ignored) is where the callback sends
// the browser after sign-in.
func (h *Routes) handleLogin(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	locale := supportedLocales[strings.ToLower(q.Get("locale"))]
	st := loginState{
		State:    newSecret(32),
		Nonce:    newSecret(32),
		Verifier: oauth2.GenerateVerifier(),
		Locale:   locale,
		Expires:  h.now().Add(loginTTL).Unix(),
		ReturnTo: CleanReturnTo(q.Get("return_to")),
	}
	// /auth/login is a same-site navigation, so the SameSite=Strict session
	// cookie is here. The callback may not have it: the IdP's redirect is
	// same-site only while the IdP shares this site (auth.hoandat.com and
	// chat.hoandat.com do; another IdP host may not), so the hash travels
	// in the sealed login cookie instead.
	if hash, ok := hashToken(SessionToken(r.Header)); ok {
		st.Replaces = base64.RawURLEncoding.EncodeToString(hash)
	}
	target, err := h.cfg.IdP.AuthCodeURL(AuthRequest{
		State: st.State, Nonce: st.Nonce, Verifier: st.Verifier,
		Locale: locale, Create: q.Get("prompt") == "create", Reauth: q.Get("reauth") == "1",
	})
	if err != nil {
		h.cfg.Logger.Warn("sign-in unavailable", "err", err)
		writeErrorPage(w, http.StatusServiceUnavailable, msgIdPUnavailable, locale, st.ReturnTo)
		return
	}
	if err := setLoginCookie(w, h.login, st); err != nil {
		h.cfg.Logger.Error("login cookie", "err", err)
		writeErrorPage(w, http.StatusInternalServerError, msgSignInFailed, locale, st.ReturnTo)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	http.Redirect(w, r, target, http.StatusFound)
}

// handleCallback finishes sign-in: it checks state against the login
// cookie, redeems the code, verifies the ID token (iss, aud, ES256, nonce),
// creates or refreshes the user and issues the session cookie.
func (h *Routes) handleCallback(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	st, err := readLoginCookie(r, h.login, h.now())
	fail := func(status int, msg pageMessage, reason string, err error) {
		h.cfg.Logger.Warn("sign-in callback rejected", "reason", reason, "err", err)
		writeErrorPage(w, status, msg, st.Locale, st.ReturnTo)
	}
	if err != nil {
		clearCookie(w, LoginCookieName, http.SameSiteLaxMode)
		fail(http.StatusBadRequest, msgSignInFailed, "login state", err)
		return
	}
	// A callback whose state is not this sign-in's (a page that sent the
	// browser here) leaves the sign-in in progress alone; once the state
	// matches, the login state is single use whatever happens next.
	if subtle.ConstantTimeCompare([]byte(q.Get("state")), []byte(st.State)) != 1 {
		fail(http.StatusBadRequest, msgSignInFailed, "state mismatch", nil)
		return
	}
	clearCookie(w, LoginCookieName, http.SameSiteLaxMode)
	if idpErr := q.Get("error"); idpErr != "" {
		fail(http.StatusBadRequest, msgSignInFailed, "IdP error "+truncate(idpErr, 64), nil)
		return
	}
	code := q.Get("code")
	if code == "" {
		fail(http.StatusBadRequest, msgSignInFailed, "no code", nil)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), callbackTimeout)
	defer cancel()
	tokens, err := h.cfg.IdP.Exchange(ctx, code, st.Verifier)
	switch {
	case errors.Is(err, ErrIdPUnavailable):
		fail(http.StatusServiceUnavailable, msgIdPUnavailable, "IdP not discovered", err)
		return
	case err != nil:
		fail(http.StatusBadRequest, msgSignInFailed, "code exchange", err)
		return
	}
	if subtle.ConstantTimeCompare([]byte(tokens.Claims.Nonce), []byte(st.Nonce)) != 1 {
		fail(http.StatusBadRequest, msgSignInFailed, "nonce mismatch", nil)
		return
	}
	c := tokens.Claims
	ip := ClientIP(r.RemoteAddr, r.Header)
	user, err := h.cfg.Store.UpsertIdPUserAdmitting(ctx, h.cfg.TenantID, c.idpProfile(), func() bool { return h.admitSignup(ip) })
	if errors.Is(err, store.ErrSignupLimited) {
		fail(http.StatusTooManyRequests, msgSignupLimited, "new account limit", nil)
		return
	}
	if err != nil {
		fail(http.StatusInternalServerError, msgSignInFailed, "upsert user", err)
		return
	}
	token, sessionID, err := h.cfg.Sessions.Create(ctx, NewSessionData{
		UserID: user.ID, IdPSID: c.SessionID, RefreshToken: tokens.RefreshToken, IDToken: tokens.IDToken,
		UserAgent: r.UserAgent(), IP: ip, AuthTime: c.AuthTime,
	})
	if err != nil {
		fail(http.StatusInternalServerError, msgSignInFailed, "create session", err)
		return
	}
	h.cfg.Logger.Info("signed in", "user_id", user.ID, "session_id", sessionID)
	setSessionCookie(w, token)
	writeInterstitial(w, st.Locale, st.ReturnTo)
	replaced, err := base64.RawURLEncoding.DecodeString(st.Replaces)
	if err != nil || len(replaced) == 0 {
		return
	}
	// The old session would linger in the session list as a duplicate of
	// this browser. It is revoked only once the response carrying the new
	// cookie has left: the revocation tells the browser's other tabs to
	// reconnect, and they must find the new cookie already stored. The
	// browser may hang up once it has the page, so the revocation runs on a
	// context that outlives the request.
	if err := http.NewResponseController(w).Flush(); err != nil {
		h.cfg.Logger.Warn("flushing the sign-in response failed", "err", err)
	}
	rctx, rcancel := context.WithTimeout(context.WithoutCancel(r.Context()), replaceTimeout)
	defer rcancel()
	if err := h.cfg.Sessions.Replace(rctx, replaced, sessionID, user.ID, c.SessionID); err != nil {
		h.cfg.Logger.Warn("revoking the replaced session failed", "session_id", sessionID, "err", err)
	}
}

// idpProfile is what the claims tell the store about the user.
func (c IDClaims) idpProfile() store.IdPProfile {
	return store.IdPProfile{
		Sub: c.Subject, PreferredUsername: c.PreferredUsername, Name: c.Name,
		Email:          store.IdPEmail{Email: c.Email, Verified: c.EmailVerified},
		EmailUnknown:   !c.EmailKnown,
		Picture:        c.Picture,
		PictureUnknown: !c.PictureKnown,
	}
}

// handleLogout ends the browser's session and sends it to the IdP
// end_session_endpoint with id_token_hint, so the ID token never reaches
// JavaScript. It requires a same-origin Origin header. Without a session
// (or after the ID token was already used) it only returns to "/".
func (h *Routes) handleLogout(w http.ResponseWriter, r *http.Request) {
	if !h.cfg.Origins.Allowed(r.Header.Get("Origin")) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	target := "/"
	if token := SessionToken(r.Header); token != "" {
		hint, err := h.cfg.Sessions.EndForLogout(r.Context(), token)
		switch {
		case err == nil && hint != "":
			if u, ok := h.cfg.IdP.EndSessionURL(hint, h.cfg.PublicOrigin+"/"); ok {
				target = u
			}
		case err != nil && !errors.Is(err, ErrNoSession):
			h.cfg.Logger.Error("logout", "err", err)
		}
	}
	clearCookie(w, SessionCookieName, http.SameSiteStrictMode)
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, target, http.StatusSeeOther)
}

// handleBackchannelLogout accepts the IdP's server-to-server logout token
// (no cookie, no CSRF check): 200 when processed, 400 when the token is
// invalid or replayed.
func (h *Routes) handleBackchannelLogout(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	r.Body = http.MaxBytesReader(w, r.Body, maxBackchannelBody)
	if err := r.ParseForm(); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	raw := r.PostForm.Get("logout_token")
	if raw == "" {
		http.Error(w, "missing logout_token", http.StatusBadRequest)
		return
	}
	claims, err := h.cfg.IdP.VerifyLogoutToken(r.Context(), raw, h.now())
	switch {
	case errors.Is(err, ErrIdPUnavailable):
		http.Error(w, "temporarily unavailable", http.StatusServiceUnavailable)
		return
	case err != nil:
		h.cfg.Logger.Warn("back-channel logout token rejected", "err", err)
		http.Error(w, "invalid logout_token", http.StatusBadRequest)
		return
	}
	fresh, revoked, err := h.cfg.Store.BackchannelLogout(r.Context(), h.cfg.TenantID, claims.ClientID,
		claims.JTI, logoutJTITTL, claims.SessionID, claims.Subject)
	if err != nil {
		h.cfg.Logger.Error("back-channel logout", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if !fresh {
		h.cfg.Logger.Warn("back-channel logout token replayed")
		http.Error(w, "logout_token already used", http.StatusBadRequest)
		return
	}
	h.cfg.Logger.Info("back-channel logout", "sessions_revoked", revoked, "by_sid", claims.SessionID != "")
	w.WriteHeader(http.StatusOK)
}

// ClientIP returns the client address of a request. The server listens on
// loopback behind nginx, so X-Real-IP is trusted only from a loopback peer.
// It returns "" when no address can be parsed.
func ClientIP(remoteAddr string, h http.Header) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	peer, err := netip.ParseAddr(host)
	if err != nil {
		return ""
	}
	if peer.IsLoopback() {
		if real, err := netip.ParseAddr(strings.TrimSpace(h.Get("X-Real-IP"))); err == nil {
			return real.Unmap().String()
		}
	}
	return peer.Unmap().String()
}

// admitSignup takes one new-account token of ip and of the tenant.
func (h *Routes) admitSignup(ip string) bool {
	if h.cfg.Limiter == nil {
		return true
	}
	if n := float64(h.cfg.SignupsPerIPHour); n > 0 && !h.cfg.Limiter.Allow(ratelimit.Rule{Rate: n / 3600, Burst: n}, "signup-ip:"+signupNetwork(ip)) {
		return false
	}
	n := float64(h.cfg.SignupsPer10Min)
	return n == 0 || h.cfg.Limiter.Allow(ratelimit.Rule{Rate: n / 600, Burst: n}, "signup-tenant")
}

// signupNetwork is the address the per-address sign-up limit counts: an
// IPv6 address by its /64 (one subscriber gets a whole /64), IPv4 as is.
func signupNetwork(ip string) string {
	addr, err := netip.ParseAddr(ip)
	if err != nil || addr.Is4() {
		return ip
	}
	prefix, err := addr.Prefix(64)
	if err != nil {
		return ip
	}
	return prefix.String()
}
