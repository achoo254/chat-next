package rpc

import (
	"context"
	"errors"
	"log/slog"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/auth"
	"app.local/server/internal/store"
	"connectrpc.com/connect"
)

// authService implements AuthService. It has no session list: where the
// account is signed in is listed and ended only at the IdP's account page
// (ADR 0006).
type authService struct {
	appv1connect.UnimplementedAuthServiceHandler
	idp        *auth.IdP
	sessions   *auth.Sessions
	signIn     *auth.Routes
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
