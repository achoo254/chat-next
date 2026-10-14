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

// authService implements AuthService. ExchangeNativeCode stays
// Unimplemented until native clients ship.
type authService struct {
	appv1connect.UnimplementedAuthServiceHandler
	idp        *auth.IdP
	sessions   *auth.Sessions
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
	clientID := s.idp.ClientID()
	switch req.Msg.GetPlatform() {
	case appv1.ClientPlatform_CLIENT_PLATFORM_IOS, appv1.ClientPlatform_CLIENT_PLATFORM_ANDROID:
		clientID = auth.MobileClientID
	case appv1.ClientPlatform_CLIENT_PLATFORM_DESKTOP:
		clientID = auth.DesktopClientID
	default:
		// Web and unspecified use the web client.
	}
	return connect.NewResponse(&appv1.GetAuthConfigResponse{
		Issuer:                s.idp.Issuer(),
		ClientId:              clientID,
		AuthorizationEndpoint: endpoint,
		Scopes:                auth.Scopes,
		TenantName:            s.tenantName,
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
		return nil, internal(s.logger, req.Spec().Procedure, err)
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
		return nil, internal(s.logger, req.Spec().Procedure, err)
	}
	now := time.Now()
	out := make([]*appv1.Session, 0, len(list))
	for _, x := range list {
		current := x.ID == sess.ID
		out = append(out, &appv1.Session{
			Id:           x.ID,
			Platform:     s.platformOf(x.IdPClientID),
			DeviceName:   DeviceName(x.UserAgent),
			CreatedAt:    x.CreatedAt.Unix(),
			LastActiveAt: x.LastSeenAt.Unix(),
			Current:      current,
			NewLogin:     !current && now.Sub(x.CreatedAt) < newLoginWindow,
		})
	}
	return connect.NewResponse(&appv1.ListSessionsResponse{Sessions: out}), nil
}

func (s *authService) platformOf(clientID string) appv1.ClientPlatform {
	switch clientID {
	case s.idp.ClientID():
		return appv1.ClientPlatform_CLIENT_PLATFORM_WEB
	case auth.DesktopClientID:
		return appv1.ClientPlatform_CLIENT_PLATFORM_DESKTOP
	default:
		// chat-mobile does not tell iOS from Android.
		return appv1.ClientPlatform_CLIENT_PLATFORM_UNSPECIFIED
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
		return nil, internal(s.logger, req.Spec().Procedure, err)
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
		return nil, internal(s.logger, req.Spec().Procedure, err)
	}
	return connect.NewResponse(&appv1.RevokeOtherSessionsResponse{RevokedCount: int32(min(n, math.MaxInt32))}), nil
}
