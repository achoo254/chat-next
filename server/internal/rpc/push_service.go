package rpc

import (
	"context"
	"errors"
	"log/slog"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/push"
	"app.local/server/internal/webpush"
	"connectrpc.com/connect"
)

// pushService implements PushService: the calling session's Web Push
// registration.
type pushService struct {
	appv1connect.UnimplementedPushServiceHandler
	push   *push.Service
	logger *slog.Logger
}

func (s *pushService) GetWebPushConfig(ctx context.Context, req *connect.Request[appv1.GetWebPushConfigRequest]) (*connect.Response[appv1.GetWebPushConfigResponse], error) {
	sess, err := mustSession(ctx)
	if err != nil {
		return nil, err
	}
	key, endpoint, err := s.push.WebPushConfig(ctx, sess.ID)
	if err != nil {
		return nil, internal(ctx, s.logger, req.Spec().Procedure, err)
	}
	return connect.NewResponse(&appv1.GetWebPushConfigResponse{ApplicationServerKey: key, Endpoint: endpoint}), nil
}

func (s *pushService) RegisterWebPush(ctx context.Context, req *connect.Request[appv1.RegisterWebPushRequest]) (*connect.Response[appv1.RegisterWebPushResponse], error) {
	sess, err := mustSession(ctx)
	if err != nil {
		return nil, err
	}
	m := req.Msg
	err = s.push.Register(ctx, sess.UserID, sess.ID, push.Subscription{
		Endpoint: m.GetEndpoint(), Keys: webpush.Keys{P256DH: m.GetP256Dh(), Auth: m.GetAuth()}, Locale: m.GetLocale(),
	})
	switch {
	case errors.Is(err, push.ErrDisabled):
		return nil, connect.NewError(connect.CodeFailedPrecondition, err)
	case errors.Is(err, push.ErrInvalid):
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	case err != nil:
		return nil, internal(ctx, s.logger, req.Spec().Procedure, err)
	}
	return connect.NewResponse(&appv1.RegisterWebPushResponse{}), nil
}

func (s *pushService) UnregisterWebPush(ctx context.Context, req *connect.Request[appv1.UnregisterWebPushRequest]) (*connect.Response[appv1.UnregisterWebPushResponse], error) {
	sess, err := mustSession(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.push.Unregister(ctx, sess.ID); err != nil {
		return nil, internal(ctx, s.logger, req.Spec().Procedure, err)
	}
	return connect.NewResponse(&appv1.UnregisterWebPushResponse{}), nil
}
