package rpc

import (
	"context"
	"errors"
	"log/slog"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/botadmin"
	"app.local/server/internal/chat"
	"connectrpc.com/connect"
)

// botsService implements BotsService, the client side of bots: starting a
// bot and its public profile. Inline mode and Mini Apps come in later
// releases.
type botsService struct {
	appv1connect.UnimplementedBotsServiceHandler
	chat   *chat.Service
	bots   *botadmin.Service
	logger *slog.Logger
}

func (s *botsService) StartBot(ctx context.Context, req *connect.Request[appv1.StartBotRequest]) (*connect.Response[appv1.StartBotResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.StartBotRequest) (*appv1.StartBotResponse, error) {
		return s.chat.StartBot(ctx, me, m)
	})
}

// GetBotInfo picks the command scope from the caller's place in chat_id:
// a group (admin or member) or the private chat.
func (s *botsService) GetBotInfo(ctx context.Context, req *connect.Request[appv1.GetBotInfoRequest]) (*connect.Response[appv1.GetBotInfoResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.GetBotInfoRequest) (*appv1.GetBotInfoResponse, error) {
		role := botadmin.RolePrivate
		if m.GetChatId() != 0 {
			c, _, err := s.chat.GetChat(ctx, me, m.GetChatId())
			if err != nil {
				return nil, err
			}
			switch {
			case c.GetType() == appv1.ChatType_CHAT_TYPE_PRIVATE:
			case c.GetMyRole() == appv1.MemberRole_MEMBER_ROLE_ADMIN || c.GetMyRole() == appv1.MemberRole_MEMBER_ROLE_OWNER:
				role = botadmin.RoleGroupAdmin
			default:
				role = botadmin.RoleGroupMember
			}
		}
		return s.bots.Info(ctx, me, m.GetBotId(), role)
	})
}

func (s *botsService) InlineQuery(context.Context, *connect.Request[appv1.InlineQueryRequest]) (*connect.Response[appv1.InlineQueryResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("inline_mode_unavailable: inline mode comes in a later release"))
}

func (s *botsService) OpenMiniApp(context.Context, *connect.Request[appv1.OpenMiniAppRequest]) (*connect.Response[appv1.OpenMiniAppResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("mini_apps_unavailable: Mini Apps come in a later release"))
}

// botAdminService implements BotAdminService (Developer Console). Token
// reveal and deletion pass the session's IdP auth_time for the recent
// sign-in rule of ADR 0006.
type botAdminService struct {
	appv1connect.UnimplementedBotAdminServiceHandler
	bots   *botadmin.Service
	logger *slog.Logger
}

func (s *botAdminService) ListMyBots(ctx context.Context, req *connect.Request[appv1.ListMyBotsRequest]) (*connect.Response[appv1.ListMyBotsResponse], error) {
	return call(ctx, s.logger, req, func(me int64, _ *appv1.ListMyBotsRequest) (*appv1.ListMyBotsResponse, error) {
		bots, err := s.bots.ListMyBots(ctx, me)
		if err != nil {
			return nil, err
		}
		return &appv1.ListMyBotsResponse{Bots: bots}, nil
	})
}

func (s *botAdminService) CreateBot(ctx context.Context, req *connect.Request[appv1.CreateBotRequest]) (*connect.Response[appv1.CreateBotResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.CreateBotRequest) (*appv1.CreateBotResponse, error) {
		bot, err := s.bots.CreateBot(ctx, me, m.GetUsername(), m.GetName())
		if err != nil {
			return nil, err
		}
		return &appv1.CreateBotResponse{Bot: bot}, nil
	})
}

func (s *botAdminService) UpdateBot(ctx context.Context, req *connect.Request[appv1.UpdateBotRequest]) (*connect.Response[appv1.UpdateBotResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.UpdateBotRequest) (*appv1.UpdateBotResponse, error) {
		bot, err := s.bots.UpdateBot(ctx, me, m)
		if err != nil {
			return nil, err
		}
		return &appv1.UpdateBotResponse{Bot: bot}, nil
	})
}

func (s *botAdminService) ResetBotToken(ctx context.Context, req *connect.Request[appv1.ResetBotTokenRequest]) (*connect.Response[appv1.ResetBotTokenResponse], error) {
	sess, err := mustSession(ctx)
	if err != nil {
		return nil, err
	}
	bot, token, err := s.bots.ResetBotToken(ctx, sess.UserID, sess.AuthTime, req.Msg.GetBotId())
	if err != nil {
		return nil, fail(ctx, s.logger, req.Spec().Procedure, err)
	}
	return connect.NewResponse(&appv1.ResetBotTokenResponse{Bot: bot, Token: token}), nil
}

func (s *botAdminService) DeleteBot(ctx context.Context, req *connect.Request[appv1.DeleteBotRequest]) (*connect.Response[appv1.DeleteBotResponse], error) {
	sess, err := mustSession(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.bots.DeleteBot(ctx, sess.UserID, sess.AuthTime, req.Msg.GetBotId()); err != nil {
		return nil, fail(ctx, s.logger, req.Spec().Procedure, err)
	}
	return connect.NewResponse(&appv1.DeleteBotResponse{}), nil
}
