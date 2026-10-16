package rpc

import (
	"context"
	"log/slog"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/privacy"
	"app.local/server/internal/store"
	"connectrpc.com/connect"
)

// privacyService implements PrivacyService on package privacy.
type privacyService struct {
	appv1connect.UnimplementedPrivacyServiceHandler
	privacy  *privacy.Service
	store    *store.Store
	tenantID string
	logger   *slog.Logger
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

func (s *privacyService) GetAccountDeletion(ctx context.Context, req *connect.Request[appv1.GetAccountDeletionRequest]) (*connect.Response[appv1.GetAccountDeletionResponse], error) {
	sess, err := mustSession(ctx)
	if err != nil {
		return nil, err
	}
	resp, err := s.privacy.DeletionInfo(ctx, sess.UserID, sess.AuthTime)
	if err != nil {
		return nil, fail(ctx, s.logger, req.Spec().Procedure, err)
	}
	return connect.NewResponse(resp), nil
}

func (s *privacyService) SetAutoDelete(ctx context.Context, req *connect.Request[appv1.SetAutoDeleteRequest]) (*connect.Response[appv1.SetAutoDeleteResponse], error) {
	sess, err := mustSession(ctx)
	if err != nil {
		return nil, err
	}
	months, err := s.privacy.SetAutoDelete(ctx, sess.UserID, req.Msg.GetMonths())
	if err != nil {
		return nil, fail(ctx, s.logger, req.Spec().Procedure, err)
	}
	return connect.NewResponse(&appv1.SetAutoDeleteResponse{Months: months}), nil
}

func (s *privacyService) DeleteAccount(ctx context.Context, req *connect.Request[appv1.DeleteAccountRequest]) (*connect.Response[appv1.DeleteAccountResponse], error) {
	sess, err := mustSession(ctx)
	if err != nil {
		return nil, err
	}
	purgeAt, err := s.privacy.RequestDeletion(ctx, sess.UserID, sess.AuthTime, req.Msg.GetConfirmation())
	if err != nil {
		return nil, fail(ctx, s.logger, req.Spec().Procedure, err)
	}
	return connect.NewResponse(&appv1.DeleteAccountResponse{PurgeAt: purgeAt.Unix()}), nil
}

func (s *privacyService) CancelAccountDeletion(ctx context.Context, req *connect.Request[appv1.CancelAccountDeletionRequest]) (*connect.Response[appv1.CancelAccountDeletionResponse], error) {
	sess, err := mustSession(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.privacy.CancelDeletion(ctx, sess.UserID); err != nil {
		return nil, fail(ctx, s.logger, req.Spec().Procedure, err)
	}
	u, err := s.store.UserByID(ctx, s.tenantID, sess.UserID)
	if err != nil {
		return nil, internal(ctx, s.logger, req.Spec().Procedure, err)
	}
	return connect.NewResponse(&appv1.CancelAccountDeletionResponse{User: selfUser(u)}), nil
}
