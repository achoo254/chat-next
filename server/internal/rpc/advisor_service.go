package rpc

import (
	"context"
	"log/slog"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/chat"
	"connectrpc.com/connect"
)

// advisorService implements AdvisorService: the caller's Advisor profile
// (name, look, tone), synced to the caller's sessions. No secret goes
// through it: the TypeSafe key stays on the user's machines.
type advisorService struct {
	appv1connect.UnimplementedAdvisorServiceHandler
	chat   *chat.Service
	logger *slog.Logger
}

func (s *advisorService) GetAdvisorProfile(ctx context.Context, req *connect.Request[appv1.GetAdvisorProfileRequest]) (*connect.Response[appv1.GetAdvisorProfileResponse], error) {
	return call(ctx, s.logger, req, func(me int64, _ *appv1.GetAdvisorProfileRequest) (*appv1.GetAdvisorProfileResponse, error) {
		profile, err := s.chat.GetAdvisorProfile(ctx, me)
		if err != nil {
			return nil, err
		}
		return &appv1.GetAdvisorProfileResponse{Profile: profile}, nil
	})
}

func (s *advisorService) SetAdvisorProfile(ctx context.Context, req *connect.Request[appv1.SetAdvisorProfileRequest]) (*connect.Response[appv1.SetAdvisorProfileResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.SetAdvisorProfileRequest) (*appv1.SetAdvisorProfileResponse, error) {
		return s.chat.SetAdvisorProfile(ctx, me, m)
	})
}
