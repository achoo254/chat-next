package auth

import (
	"context"
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"

	"app.local/server/internal/store"
)

// Origins of the native app's WebView (ADR 0006, ADR 0011): Capacitor serves
// the bundled web app from capacitor://localhost on iOS and
// https://localhost on Android, whatever the tenant. They are accepted only
// for requests authenticated with a session token in the Authorization
// header (or the first WebSocket frame), never for the session cookie.
const (
	NativeOriginIOS     = "capacitor://localhost"
	NativeOriginAndroid = "https://localhost"
)

// Native reports whether an Origin header value is one of the native app's
// WebView origins.
func (o *Origins) Native(origin string) bool {
	return strings.EqualFold(origin, NativeOriginIOS) || strings.EqualFold(origin, NativeOriginAndroid)
}

// BearerToken returns the token of an "Authorization: Bearer <token>"
// header, or "".
func BearerToken(h http.Header) string {
	scheme, token, ok := strings.Cut(h.Get("Authorization"), " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return ""
	}
	return strings.TrimSpace(token)
}

// RequestToken returns the session token a request authenticates with. An
// Authorization bearer token wins (bearer is true; only a native session
// accepts it, Sessions.AuthenticateBearer). Otherwise the session cookie is
// used, except for a request from a native origin (nativeOrigin): the
// WebView never holds a chat cookie, so one arriving from there is not
// trusted and the request is treated as signed out.
func RequestToken(h http.Header, nativeOrigin bool) (token string, bearer bool) {
	if t := BearerToken(h); t != "" {
		return t, true
	}
	if nativeOrigin {
		return "", false
	}
	return SessionToken(h), false
}

// CORS of the Connect API for the native app. The headers are the ones
// connect-web sends and reads (https://connectrpc.com/docs/cors) plus
// Authorization; credentials are never allowed, so the browser sends no
// cookie with them.
const (
	corsAllowMethods  = "POST, GET"
	corsAllowHeaders  = "Authorization, Content-Type, Connect-Protocol-Version, Connect-Timeout-Ms, Grpc-Timeout, X-Grpc-Web, X-User-Agent"
	corsExposeHeaders = "Grpc-Status, Grpc-Message, Grpc-Status-Details-Bin"
	corsMaxAge        = "7200"
)

// NativeCORS answers CORS for the native app's origins only: a preflight
// from them gets 204 with the allowed methods and headers, and their
// requests the Allow-Origin header. Requests from any other origin pass
// through untouched (the web app is same-origin and needs no CORS).
func NativeCORS(origins *Origins, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		w.Header().Add("Vary", "Origin")
		if !origins.Native(origin) {
			next.ServeHTTP(w, r)
			return
		}
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", origin)
		if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
			h.Add("Vary", "Access-Control-Request-Method")
			h.Add("Vary", "Access-Control-Request-Headers")
			h.Set("Access-Control-Allow-Methods", corsAllowMethods)
			h.Set("Access-Control-Allow-Headers", corsAllowHeaders)
			h.Set("Access-Control-Max-Age", corsMaxAge)
			w.WriteHeader(http.StatusNoContent)
			return
		}
		h.Set("Access-Control-Expose-Headers", corsExposeHeaders)
		next.ServeHTTP(w, r)
	})
}

// ErrRedirectMismatch: the redirect_uri of a native sign-in is not the
// native client's.
var ErrRedirectMismatch = errors.New("auth: redirect_uri is not the native client's")

// NativeSignIn is a native app's request to turn an authorization code into
// a chat session (AuthService.ExchangeNativeCode).
type NativeSignIn struct {
	Code        string
	Verifier    string
	RedirectURI string
	Device      NativeDevice
	UserAgent   string
	IP          string
	// ReplacesToken is the bearer token the app sent along: when it is a
	// native session of the same user (a sign-in again to confirm a
	// sensitive action), the new session replaces it.
	ReplacesToken string
}

// NativeSession is the session a native sign-in created.
type NativeSession struct {
	Token     string
	SessionID int64
	User      store.User
}

// SignInNative redeems a native authorization code at the tenant's token
// endpoint with its PKCE verifier (the public chat-mobile client), verifies
// the ID token as the web callback does (iss, aud chat-mobile, ES256, exp;
// PKCE binds the code to this app, so no nonce is involved), creates or
// refreshes the user under the same sign-up limits as the web, and issues a
// native session. Errors: ErrRedirectMismatch, ErrNativeDisabled,
// ErrIdPUnavailable, ErrCodeRejected or ErrInvalidToken (sign in again),
// store.ErrSignupLimited, or an internal error.
func (h *Routes) SignInNative(ctx context.Context, in NativeSignIn) (NativeSession, error) {
	want := h.cfg.IdP.MobileRedirectURL()
	if want == "" {
		return NativeSession{}, ErrNativeDisabled
	}
	if subtle.ConstantTimeCompare([]byte(in.RedirectURI), []byte(want)) != 1 {
		return NativeSession{}, ErrRedirectMismatch
	}
	ctx, cancel := context.WithTimeout(ctx, callbackTimeout)
	defer cancel()
	tokens, err := h.cfg.IdP.ExchangeNative(ctx, in.Code, in.Verifier)
	if err != nil {
		return NativeSession{}, err
	}
	c := tokens.Claims
	user, err := h.cfg.Store.UpsertIdPUserAdmitting(ctx, h.cfg.TenantID, c.idpProfile(), func() bool { return h.admitSignup(in.IP) })
	if err != nil {
		return NativeSession{}, err
	}
	device := in.Device
	token, sessionID, err := h.cfg.Sessions.Create(ctx, NewSessionData{
		UserID: user.ID, IdPSID: c.SessionID, RefreshToken: tokens.RefreshToken, IDToken: tokens.IDToken,
		UserAgent: in.UserAgent, IP: in.IP, AuthTime: c.AuthTime, Native: &device,
	})
	if err != nil {
		return NativeSession{}, err
	}
	h.cfg.Logger.Info("signed in (native app)", "user_id", user.ID, "session_id", sessionID, "platform", device.Platform)
	h.replaceNative(ctx, in.ReplacesToken, sessionID, user.ID, c.SessionID)
	return NativeSession{Token: token, SessionID: sessionID, User: user}, nil
}

// replaceNative revokes (reason replaced) the native session the app signed
// in from, so that a confirmation sign-in does not leave a duplicate device
// in the session list. Only a native session of the same user is replaced;
// anything else is left alone. Failures are logged: the new session works
// regardless.
func (h *Routes) replaceNative(ctx context.Context, oldToken string, newID, userID int64, idpSID string) {
	if oldToken == "" {
		return
	}
	old, err := h.cfg.Sessions.AuthenticateBearer(ctx, oldToken)
	if err != nil || old.UserID != userID || old.ID == newID {
		return
	}
	hash, ok := hashToken(oldToken)
	if !ok {
		return
	}
	rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), replaceTimeout)
	defer cancel()
	if err := h.cfg.Sessions.Replace(rctx, hash, newID, userID, idpSID); err != nil {
		h.cfg.Logger.Warn("revoking the replaced native session failed", "session_id", newID, "err", err)
	}
}
