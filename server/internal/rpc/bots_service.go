package rpc

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/botadmin"
	"app.local/server/internal/botupdates"
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
	bots    *botadmin.Service
	updates *botupdates.Service
	logger  *slog.Logger
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

// deadLettersPerCall bounds the update ids of one retry or discard.
const deadLettersPerCall = 100

// deliveryError maps the errors of the webhook settings.
func deliveryError(err error) error {
	var we *botupdates.WebhookError
	switch {
	case errors.As(err, &we):
		return connect.NewError(connect.CodeInvalidArgument, errors.New(we.Error()))
	case errors.Is(err, botupdates.ErrNoBot):
		return connect.NewError(connect.CodeNotFound, errors.New("bot not found"))
	default:
		return err
	}
}

func unixOrZero(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.Unix()
}

func renderWebhook(info *botupdates.WebhookInfo) *appv1.BotWebhook {
	kinds := info.AllowedUpdates
	if kinds == nil {
		kinds = []string{}
	}
	return &appv1.BotWebhook{Url: info.URL, AllowedUpdates: kinds, MaxConnections: int32(info.MaxConnections)}
}

func (s *botAdminService) GetBotDelivery(ctx context.Context, req *connect.Request[appv1.GetBotDeliveryRequest]) (*connect.Response[appv1.GetBotDeliveryResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.GetBotDeliveryRequest) (*appv1.GetBotDeliveryResponse, error) {
		if _, err := s.bots.Owned(ctx, me, m.GetBotId()); err != nil {
			return nil, err
		}
		info, err := s.updates.WebhookInfo(ctx, m.GetBotId())
		if err != nil {
			return nil, deliveryError(err)
		}
		stats, err := s.updates.Stats(ctx, m.GetBotId())
		if err != nil {
			return nil, err
		}
		return &appv1.GetBotDeliveryResponse{
			Webhook: renderWebhook(info),
			Status: &appv1.BotDeliveryStatus{
				PendingCount: info.Pending, DeadLetterCount: info.DeadLetters, LastError: info.LastError,
				LastErrorDate: unixOrZero(info.LastErrorAt), LastSuccessDate: unixOrZero(info.LastDeliveredAt),
				LastSuccessMs: int32(info.LastDelivery.Milliseconds()), OpenConnections: int32(info.OpenConnections),
			},
			Stats: &appv1.BotDeliveryStats{
				Received: stats.Received, Delivered: stats.Delivered, Failed: stats.Failed, DeadLettered: stats.DeadLettered,
			},
		}, nil
	})
}

func (s *botAdminService) SetBotWebhook(ctx context.Context, req *connect.Request[appv1.SetBotWebhookRequest]) (*connect.Response[appv1.SetBotWebhookResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.SetBotWebhookRequest) (*appv1.SetBotWebhookResponse, error) {
		if _, err := s.bots.Owned(ctx, me, m.GetBotId()); err != nil {
			return nil, err
		}
		err := s.updates.SetWebhook(ctx, m.GetBotId(), botupdates.WebhookSettings{
			URL: m.GetUrl(), Secret: m.GetSecret(), AllowedUpdates: m.GetAllowedUpdates(),
			MaxConnections: int(m.GetMaxConnections()), DropPending: m.GetDropPending(),
		})
		if err != nil {
			return nil, deliveryError(err)
		}
		info, err := s.updates.WebhookInfo(ctx, m.GetBotId())
		if err != nil {
			return nil, deliveryError(err)
		}
		return &appv1.SetBotWebhookResponse{Webhook: renderWebhook(info)}, nil
	})
}

func (s *botAdminService) DeleteBotWebhook(ctx context.Context, req *connect.Request[appv1.DeleteBotWebhookRequest]) (*connect.Response[appv1.DeleteBotWebhookResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.DeleteBotWebhookRequest) (*appv1.DeleteBotWebhookResponse, error) {
		if _, err := s.bots.Owned(ctx, me, m.GetBotId()); err != nil {
			return nil, err
		}
		if err := s.updates.DeleteWebhook(ctx, m.GetBotId(), m.GetDropPending()); err != nil {
			return nil, deliveryError(err)
		}
		return &appv1.DeleteBotWebhookResponse{}, nil
	})
}

func (s *botAdminService) ListBotDeadLetters(ctx context.Context, req *connect.Request[appv1.ListBotDeadLettersRequest]) (*connect.Response[appv1.ListBotDeadLettersResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.ListBotDeadLettersRequest) (*appv1.ListBotDeadLettersResponse, error) {
		if _, err := s.bots.Owned(ctx, me, m.GetBotId()); err != nil {
			return nil, err
		}
		list, total, err := s.updates.DeadLetters(ctx, m.GetBotId())
		if err != nil {
			return nil, err
		}
		out := &appv1.ListBotDeadLettersResponse{DeadLetters: make([]*appv1.BotDeadLetter, 0, len(list)), Total: total}
		for _, d := range list {
			out.DeadLetters = append(out.DeadLetters, &appv1.BotDeadLetter{
				UpdateId: d.UpdateID, Kind: d.Kind, ChatId: d.ChatID, ChatTitle: d.ChatTitle, LastError: d.LastError,
				LastErrorDate: unixOrZero(d.LastErrorAt), Attempts: int32(d.Attempts),
			})
		}
		return out, nil
	})
}

func checkUpdateIDs(ids []int64) error {
	if len(ids) == 0 || len(ids) > deadLettersPerCall {
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("update_ids must hold 1 to %d ids", deadLettersPerCall))
	}
	return nil
}

func (s *botAdminService) RetryBotDeadLetters(ctx context.Context, req *connect.Request[appv1.RetryBotDeadLettersRequest]) (*connect.Response[appv1.RetryBotDeadLettersResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.RetryBotDeadLettersRequest) (*appv1.RetryBotDeadLettersResponse, error) {
		if err := checkUpdateIDs(m.GetUpdateIds()); err != nil {
			return nil, err
		}
		if _, err := s.bots.Owned(ctx, me, m.GetBotId()); err != nil {
			return nil, err
		}
		n, err := s.updates.RetryDeadLetters(ctx, m.GetBotId(), m.GetUpdateIds())
		if err != nil {
			return nil, err
		}
		return &appv1.RetryBotDeadLettersResponse{Retried: int32(n)}, nil
	})
}

func (s *botAdminService) DiscardBotDeadLetters(ctx context.Context, req *connect.Request[appv1.DiscardBotDeadLettersRequest]) (*connect.Response[appv1.DiscardBotDeadLettersResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.DiscardBotDeadLettersRequest) (*appv1.DiscardBotDeadLettersResponse, error) {
		if err := checkUpdateIDs(m.GetUpdateIds()); err != nil {
			return nil, err
		}
		if _, err := s.bots.Owned(ctx, me, m.GetBotId()); err != nil {
			return nil, err
		}
		n, err := s.updates.DiscardDeadLetters(ctx, m.GetBotId(), m.GetUpdateIds())
		if err != nil {
			return nil, err
		}
		return &appv1.DiscardBotDeadLettersResponse{Discarded: int32(n)}, nil
	})
}
