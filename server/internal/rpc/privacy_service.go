package rpc

import (
	"context"
	"log/slog"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/privacy"
	"connectrpc.com/connect"
)

// privacyService implements PrivacyService on package privacy.
type privacyService struct {
	appv1connect.UnimplementedPrivacyServiceHandler
	privacy *privacy.Service
	logger  *slog.Logger
}

func (s *privacyService) GetDataExport(ctx context.Context, req *connect.Request[appv1.GetDataExportRequest]) (*connect.Response[appv1.GetDataExportResponse], error) {
	sess, err := mustSession(ctx)
	if err != nil {
		return nil, err
	}
	resp, err := s.privacy.ExportState(ctx, sess.UserID)
	if err != nil {
		return nil, fail(ctx, s.logger, req.Spec().Procedure, err)
	}
	return connect.NewResponse(resp), nil
}

func (s *privacyService) RequestDataExport(ctx context.Context, req *connect.Request[appv1.RequestDataExportRequest]) (*connect.Response[appv1.RequestDataExportResponse], error) {
	sess, err := mustSession(ctx)
	if err != nil {
		return nil, err
	}
	resp, err := s.privacy.RequestExport(ctx, sess.UserID)
	if err != nil {
		return nil, fail(ctx, s.logger, req.Spec().Procedure, err)
	}
	return connect.NewResponse(resp), nil
}

func (s *privacyService) GetDataExportUrl(ctx context.Context, req *connect.Request[appv1.GetDataExportUrlRequest]) (*connect.Response[appv1.GetDataExportUrlResponse], error) {
	sess, err := mustSession(ctx)
	if err != nil {
		return nil, err
	}
	resp, err := s.privacy.ExportURL(ctx, sess.UserID, req.Msg.GetExportId())
	if err != nil {
		return nil, fail(ctx, s.logger, req.Spec().Procedure, err)
	}
	return connect.NewResponse(resp), nil
}
