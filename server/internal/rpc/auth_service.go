package rpc

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/auth"
	"app.local/server/internal/store"
	"connectrpc.com/connect"
)

// newLoginWindow marks sessions signed in this recently as new_login, so
// the other sessions can warn about them.
const newLoginWindow = 24 * time.Hour

// isNewLogin reports whether a session is flagged as a new sign-in: created
// within newLoginWindow, and never the session asking (you know you just
// signed in there).
func isNewLogin(createdAt, now time.Time, current bool) bool {
	return !current && now.Sub(createdAt) < newLoginWindow
}

// authService implements AuthService.
type authService struct {
	appv1connect.UnimplementedAuthServiceHandler
	idp        *auth.IdP
	sessions   *auth.Sessions
	signIn     *auth.Routes
	store      *store.Store
	tenantID   string
	tenantName string
	logger     *slog.Logger
}

// GetAuthConfig returns the IdP parameters of the tenant for the platform's
// client.
func (s *authService) GetAuthConfig(_ context.Context, req *connect.Request[appv1.GetAuthConfigRequest]) (*connect.Response[appv1.GetAuthConfigResponse], error) {
	endpoint, err := s.idp.AuthorizationEndpoint()
	if err != nil {
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("sign-in is temporarily unavailable"))
	}
	clientID, redirectURI := s.idp.ClientID(), ""
	if nativePlatform(req.Msg.GetPlatform()) {
		if s.idp.MobileRedirectURL() == "" {
			return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("native_sign_in_disabled: this server has no native app sign-in"))
		}
		clientID, redirectURI = auth.MobileClientID, s.idp.MobileRedirectURL()
	}
	// Web, unspecified and the retired desktop value use the web client.
	return connect.NewResponse(&appv1.GetAuthConfigResponse{
		Issuer:                s.idp.Issuer(),
		ClientId:              clientID,
		AuthorizationEndpoint: endpoint,
		Scopes:                auth.Scopes,
		TenantName:            s.tenantName,
		RedirectUri:           redirectURI,
	}), nil
}

// nativePlatform reports the platforms of the native app (chat-mobile).
func nativePlatform(p appv1.ClientPlatform) bool {
	return p == appv1.ClientPlatform_CLIENT_PLATFORM_IOS || p == appv1.ClientPlatform_CLIENT_PLATFORM_ANDROID
}

// Bounds of ExchangeNativeCode fields.
const (
	maxCodeBytes = 2048
	// RFC 7636 §4.1: 43 to 128 unreserved characters.
	minVerifierLen = 43
	maxVerifierLen = 128
)

// validVerifier reports a PKCE code_verifier of RFC 7636 §4.1 form.
func validVerifier(v string) bool {
	if len(v) < minVerifierLen || len(v) > maxVerifierLen {
		return false
	}
	for _, c := range v {
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '-', c == '.', c == '_', c == '~':
		default:
			return false
		}
	}
	return true
}

// ExchangeNativeCode redeems the authorization code the native app got
// back from the system browser (Code + PKCE with chat-mobile) and issues a
// native session: the app keeps the returned token in the platform secure
// store and sends it as "Authorization: Bearer". A bearer token sent with
// this call names the app's current session, which the new one replaces
// (signing in again to confirm a sensitive action).
func (s *authService) ExchangeNativeCode(ctx context.Context, req *connect.Request[appv1.ExchangeNativeCodeRequest]) (*connect.Response[appv1.ExchangeNativeCodeResponse], error) {
	m := req.Msg
	platform := int16(m.GetPlatform())
	switch {
	case !nativePlatform(m.GetPlatform()):
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("platform must be IOS or ANDROID"))
	case m.GetCode() == "" || len(m.GetCode()) > maxCodeBytes:
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("code is required"))
	case !validVerifier(m.GetCodeVerifier()):
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("code_verifier must be 43 to 128 unreserved characters (RFC 7636)"))
	}
	out, err := s.signIn.SignInNative(ctx, auth.NativeSignIn{
		Code: m.GetCode(), Verifier: m.GetCodeVerifier(), RedirectURI: m.GetRedirectUri(),
		Device:    auth.NativeDevice{Platform: platform, DeviceName: m.GetDeviceName(), AppVersion: m.GetAppVersion()},
		UserAgent: req.Header().Get("User-Agent"), IP: auth.ClientIP(req.Peer().Addr, req.Header()),
		ReplacesToken: auth.BearerToken(req.Header()),
	})
	switch {
	case errors.Is(err, auth.ErrRedirectMismatch):
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("redirect_uri does not match the native client"))
	case errors.Is(err, auth.ErrNativeDisabled):
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("native_sign_in_disabled: this server has no native app sign-in"))
	case errors.Is(err, auth.ErrIdPUnavailable):
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("sign-in is temporarily unavailable"))
	case errors.Is(err, auth.ErrCodeRejected), errors.Is(err, auth.ErrInvalidToken):
		s.logger.Warn("native sign-in rejected", "err", err)
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("sign_in_failed: the sign-in did not complete; start it again"))
	case errors.Is(err, store.ErrSignupLimited):
		return nil, connect.NewError(connect.CodeResourceExhausted, errors.New("signup_limited: too many new accounts; try again later"))
	case err != nil && ctx.Err() != nil:
		// The app hung up: logged at Debug, answered Canceled.
		return nil, internal(ctx, s.logger, req.Spec().Procedure, err)
	case err != nil:
		// The token endpoint could not be reached, or the database failed:
		// the app may retry with a new sign-in.
		s.logger.Error("native sign-in failed", "err", err)
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("sign-in is temporarily unavailable"))
	}
	return connect.NewResponse(&appv1.ExchangeNativeCodeResponse{
		SessionToken: out.Token,
		SessionId:    out.SessionID,
		User:         selfUser(out.User),
	}), nil
}

// SignOut revokes the calling session and its IdP refresh token. It leaves
// the cookie in place on purpose: the web client then POSTs /auth/logout,
// which uses that cookie once more to find the ID token for the IdP
// end_session_endpoint (id_token_hint) and clears the cookie.
func (s *authService) SignOut(ctx context.Context, req *connect.Request[appv1.SignOutRequest]) (*connect.Response[appv1.SignOutResponse], error) {
	sess, err := mustSession(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.sessions.Revoke(ctx, sess.UserID, sess.ID); err != nil && !errors.Is(err, store.ErrNotFound) {
		return nil, internal(ctx, s.logger, req.Spec().Procedure, err)
	}
	return connect.NewResponse(&appv1.SignOutResponse{}), nil
}

// ListSessions lists the caller's active sessions, newest first.
func (s *authService) ListSessions(ctx context.Context, req *connect.Request[appv1.ListSessionsRequest]) (*connect.Response[appv1.ListSessionsResponse], error) {
	sess, err := mustSession(ctx)
	if err != nil {
		return nil, err
	}
	list, err := s.store.ListActiveSessions(ctx, s.tenantID, sess.UserID)
	if err != nil {
		return nil, internal(ctx, s.logger, req.Spec().Procedure, err)
	}
	now := time.Now()
	out := make([]*appv1.Session, 0, len(list))
	for _, x := range list {
		current := x.ID == sess.ID
		device := DeviceName(x.UserAgent)
		if x.Native() && x.DeviceName != "" {
			device = x.DeviceName
		}
		out = append(out, &appv1.Session{
			Id:           x.ID,
			Platform:     platformOf(x),
			DeviceName:   device,
			AppVersion:   x.AppVersion,
			CreatedAt:    x.CreatedAt.Unix(),
			LastActiveAt: x.LastSeenAt.Unix(),
			Current:      current,
			NewLogin:     isNewLogin(x.CreatedAt, now, current),
		})
	}
	return connect.NewResponse(&appv1.ListSessionsResponse{Sessions: out}), nil
}

// platformOf is the platform a session signed in from.
func platformOf(x store.Session) appv1.ClientPlatform {
	switch x.Platform {
	case store.PlatformIOS:
		return appv1.ClientPlatform_CLIENT_PLATFORM_IOS
	case store.PlatformAndroid:
		return appv1.ClientPlatform_CLIENT_PLATFORM_ANDROID
	default:
		return appv1.ClientPlatform_CLIENT_PLATFORM_WEB
	}
}

// RevokeSession revokes one of the caller's sessions (the current one
// included).
func (s *authService) RevokeSession(ctx context.Context, req *connect.Request[appv1.RevokeSessionRequest]) (*connect.Response[appv1.RevokeSessionResponse], error) {
	sess, err := mustSession(ctx)
	if err != nil {
		return nil, err
	}
	if req.Msg.GetSessionId() <= 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("session_id is required"))
	}
	err = s.sessions.Revoke(ctx, sess.UserID, req.Msg.GetSessionId())
	switch {
	case errors.Is(err, store.ErrNotFound):
		return nil, connect.NewError(connect.CodeNotFound, errors.New("session not found"))
	case err != nil:
		return nil, internal(ctx, s.logger, req.Spec().Procedure, err)
	}
	return connect.NewResponse(&appv1.RevokeSessionResponse{}), nil
}

// RevokeOtherSessions revokes every session of the caller except this one.
func (s *authService) RevokeOtherSessions(ctx context.Context, req *connect.Request[appv1.RevokeOtherSessionsRequest]) (*connect.Response[appv1.RevokeOtherSessionsResponse], error) {
	sess, err := mustSession(ctx)
	if err != nil {
		return nil, err
	}
	n, err := s.sessions.RevokeOthers(ctx, sess.UserID, sess.ID)
	if err != nil {
		return nil, internal(ctx, s.logger, req.Spec().Procedure, err)
	}
	return connect.NewResponse(&appv1.RevokeOtherSessionsResponse{RevokedCount: int32(min(n, math.MaxInt32))}), nil
}
