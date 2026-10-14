package rpc

import (
	"context"
	"log/slog"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/chat"
	"connectrpc.com/connect"
)

// moderationService implements ModerationService on the chat core, which
// checks that the caller is an operator.
type moderationService struct {
	appv1connect.UnimplementedModerationServiceHandler
	chat   *chat.Service
	logger *slog.Logger
}

func (s *moderationService) GetReports(ctx context.Context, req *connect.Request[appv1.GetReportsRequest]) (*connect.Response[appv1.GetReportsResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.GetReportsRequest) (*appv1.GetReportsResponse, error) {
		return s.chat.GetReports(ctx, me, m)
	})
}

func (s *moderationService) GetReport(ctx context.Context, req *connect.Request[appv1.GetReportRequest]) (*connect.Response[appv1.GetReportResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.GetReportRequest) (*appv1.GetReportResponse, error) {
		return s.chat.GetReport(ctx, me, m.GetReportId())
	})
}

func (s *moderationService) ResolveReport(ctx context.Context, req *connect.Request[appv1.ResolveReportRequest]) (*connect.Response[appv1.ResolveReportResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.ResolveReportRequest) (*appv1.ResolveReportResponse, error) {
		return s.chat.ResolveReport(ctx, me, m)
	})
}

func (s *moderationService) LiftRestriction(ctx context.Context, req *connect.Request[appv1.LiftRestrictionRequest]) (*connect.Response[appv1.LiftRestrictionResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.LiftRestrictionRequest) (*appv1.LiftRestrictionResponse, error) {
		return &appv1.LiftRestrictionResponse{}, s.chat.LiftRestriction(ctx, me, m.GetUserId(), m.GetNote())
	})
}
