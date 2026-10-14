package rpc

import (
	"context"
	"log/slog"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/chat"
	"connectrpc.com/connect"
)

// updatesService implements UpdatesService (ADR 0002).
type updatesService struct {
	appv1connect.UnimplementedUpdatesServiceHandler
	chat   *chat.Service
	logger *slog.Logger
}

func (s *updatesService) GetState(ctx context.Context, req *connect.Request[appv1.GetStateRequest]) (*connect.Response[appv1.GetStateResponse], error) {
	return call(ctx, s.logger, req, func(me int64, _ *appv1.GetStateRequest) (*appv1.GetStateResponse, error) {
		state, err := s.chat.State(ctx, me)
		if err != nil {
			return nil, err
		}
		return &appv1.GetStateResponse{State: state}, nil
	})
}

func (s *updatesService) GetDifference(ctx context.Context, req *connect.Request[appv1.GetDifferenceRequest]) (*connect.Response[appv1.GetDifferenceResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.GetDifferenceRequest) (*appv1.GetDifferenceResponse, error) {
		return s.chat.GetDifference(ctx, me, m)
	})
}

func (s *updatesService) GetChatDifference(ctx context.Context, req *connect.Request[appv1.GetChatDifferenceRequest]) (*connect.Response[appv1.GetChatDifferenceResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.GetChatDifferenceRequest) (*appv1.GetChatDifferenceResponse, error) {
		return s.chat.GetChatDifference(ctx, me, m)
	})
}
