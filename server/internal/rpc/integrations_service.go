package rpc

import (
	"context"
	"log/slog"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/hooks"
	"connectrpc.com/connect"
)

// integrationsService implements IntegrationsService on the hooks service,
// which checks that the caller administers the hook's chat.
type integrationsService struct {
	appv1connect.UnimplementedIntegrationsServiceHandler
	hooks  *hooks.Service
	logger *slog.Logger
}

func (s *integrationsService) CreateIncomingHook(ctx context.Context, req *connect.Request[appv1.CreateIncomingHookRequest]) (*connect.Response[appv1.CreateIncomingHookResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.CreateIncomingHookRequest) (*appv1.CreateIncomingHookResponse, error) {
		return s.hooks.CreateIncomingHook(ctx, me, m)
	})
}

func (s *integrationsService) GetIncomingHooks(ctx context.Context, req *connect.Request[appv1.GetIncomingHooksRequest]) (*connect.Response[appv1.GetIncomingHooksResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.GetIncomingHooksRequest) (*appv1.GetIncomingHooksResponse, error) {
		return s.hooks.GetIncomingHooks(ctx, me, m.GetChatId())
	})
}

func (s *integrationsService) GetIncomingHook(ctx context.Context, req *connect.Request[appv1.GetIncomingHookRequest]) (*connect.Response[appv1.GetIncomingHookResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.GetIncomingHookRequest) (*appv1.GetIncomingHookResponse, error) {
		return s.hooks.GetIncomingHook(ctx, me, m.GetHookId())
	})
}

func (s *integrationsService) RotateIncomingHookSecret(ctx context.Context, req *connect.Request[appv1.RotateIncomingHookSecretRequest]) (*connect.Response[appv1.RotateIncomingHookSecretResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.RotateIncomingHookSecretRequest) (*appv1.RotateIncomingHookSecretResponse, error) {
		return s.hooks.RotateIncomingHookSecret(ctx, me, m)
	})
}

func (s *integrationsService) RevokePreviousHookSecret(ctx context.Context, req *connect.Request[appv1.RevokePreviousHookSecretRequest]) (*connect.Response[appv1.RevokePreviousHookSecretResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.RevokePreviousHookSecretRequest) (*appv1.RevokePreviousHookSecretResponse, error) {
		return s.hooks.RevokePreviousHookSecret(ctx, me, m.GetHookId())
	})
}

func (s *integrationsService) SetIncomingHookEnabled(ctx context.Context, req *connect.Request[appv1.SetIncomingHookEnabledRequest]) (*connect.Response[appv1.SetIncomingHookEnabledResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.SetIncomingHookEnabledRequest) (*appv1.SetIncomingHookEnabledResponse, error) {
		return s.hooks.SetIncomingHookEnabled(ctx, me, m)
	})
}

func (s *integrationsService) TakeOverIncomingHook(ctx context.Context, req *connect.Request[appv1.TakeOverIncomingHookRequest]) (*connect.Response[appv1.TakeOverIncomingHookResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.TakeOverIncomingHookRequest) (*appv1.TakeOverIncomingHookResponse, error) {
		return s.hooks.TakeOverIncomingHook(ctx, me, m)
	})
}

func (s *integrationsService) DeleteIncomingHook(ctx context.Context, req *connect.Request[appv1.DeleteIncomingHookRequest]) (*connect.Response[appv1.DeleteIncomingHookResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.DeleteIncomingHookRequest) (*appv1.DeleteIncomingHookResponse, error) {
		return &appv1.DeleteIncomingHookResponse{}, s.hooks.DeleteIncomingHook(ctx, me, m.GetHookId())
	})
}

func (s *integrationsService) GetIncomingHookStats(ctx context.Context, req *connect.Request[appv1.GetIncomingHookStatsRequest]) (*connect.Response[appv1.GetIncomingHookStatsResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.GetIncomingHookStatsRequest) (*appv1.GetIncomingHookStatsResponse, error) {
		return s.hooks.GetIncomingHookStats(ctx, me, m)
	})
}

func (s *integrationsService) GetIncomingHookDeadLetters(ctx context.Context, req *connect.Request[appv1.GetIncomingHookDeadLettersRequest]) (*connect.Response[appv1.GetIncomingHookDeadLettersResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.GetIncomingHookDeadLettersRequest) (*appv1.GetIncomingHookDeadLettersResponse, error) {
		return s.hooks.GetIncomingHookDeadLetters(ctx, me, m)
	})
}

func (s *integrationsService) GetIncomingHookAudit(ctx context.Context, req *connect.Request[appv1.GetIncomingHookAuditRequest]) (*connect.Response[appv1.GetIncomingHookAuditResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.GetIncomingHookAuditRequest) (*appv1.GetIncomingHookAuditResponse, error) {
		return s.hooks.GetIncomingHookAudit(ctx, me, m)
	})
}
