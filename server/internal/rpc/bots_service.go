package rpc

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/botadmin"
	"app.local/server/internal/botupdates"
	"app.local/server/internal/chat"
	"app.local/server/internal/miniapp"
	"app.local/server/internal/store"
	"connectrpc.com/connect"
)

// botsService implements BotsService, the client side of bots: starting a
// bot and its public profile, inline queries and Mini Apps.
type botsService struct {
	appv1connect.UnimplementedBotsServiceHandler
	chat    *chat.Service
	bots    *botadmin.Service
	updates *botupdates.Service
	miniApp *miniapp.Signer
	logger  *slog.Logger
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

// GetChatBotCommands lists the menus of the bots in a group for the
// caller (group admins get the GROUP_ADMIN lists).
func (s *botsService) GetChatBotCommands(ctx context.Context, req *connect.Request[appv1.GetChatBotCommandsRequest]) (*connect.Response[appv1.GetChatBotCommandsResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.GetChatBotCommandsRequest) (*appv1.GetChatBotCommandsResponse, error) {
		ids, admin, err := s.chat.ChatBots(ctx, me, m.GetChatId())
		if err != nil {
			return nil, err
		}
		role := botadmin.RoleGroupMember
		if admin {
			role = botadmin.RoleGroupAdmin
		}
		menus, err := s.bots.Menus(ctx, ids, role)
		if err != nil {
			return nil, err
		}
		return &appv1.GetChatBotCommandsResponse{Bots: menus, BotCount: int32(len(ids))}, nil
	})
}

// InlineQuery hands the query to the bot and waits for its results as a
// button press waits for its answer.
func (s *botsService) InlineQuery(ctx context.Context, req *connect.Request[appv1.InlineQueryRequest]) (*connect.Response[appv1.InlineQueryResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.InlineQueryRequest) (*appv1.InlineQueryResponse, error) {
		ask, err := s.chat.InlineQuery(ctx, me, m)
		if err != nil {
			return nil, err
		}
		if !ask.Answered {
			answered, err := s.updates.Await(ctx, ask.ID, botupdates.AnswerTimeout, func() (bool, error) {
				return s.chat.InlineAnswered(ctx, ask.ID)
			})
			if err != nil {
				return nil, err
			}
			if !answered {
				return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("bot_timeout: the bot did not answer in time"))
			}
		}
		return s.chat.InlineResults(ctx, me, ask.ID)
	})
}

// startParamPattern is the start_param of a Mini App, as of a deep link.
var startParamPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{0,64}$`)

// OpenMiniApp returns the URL to load and the signed init data. The URL
// (the bot's main one, or the button's) is checked again against the Mini
// App rules: a tenant added since the bot set it may now refuse it.
// theme_params only style the container's own chrome; they are not signed.
func (s *botsService) OpenMiniApp(ctx context.Context, req *connect.Request[appv1.OpenMiniAppRequest]) (*connect.Response[appv1.OpenMiniAppResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.OpenMiniAppRequest) (*appv1.OpenMiniAppResponse, error) {
		if !startParamPattern.MatchString(m.GetStartParam()) {
			return nil, connect.NewError(connect.CodeInvalidArgument,
				errors.New("start_param must have up to 64 characters of A-Z, a-z, 0-9, _ and -"))
		}
		bot, err := s.bots.Live(ctx, m.GetBotId())
		if err != nil {
			return nil, err
		}
		target := m.GetUrl()
		if target == "" {
			if bot.MiniAppURL == "" {
				return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("no_mini_app: this bot has no Mini App"))
			}
			target = bot.MiniAppURL
		}
		chatType, err := s.chat.MiniAppChatType(ctx, me, bot.ID, m.GetChatId(), m.GetSeq(), m.GetUrl())
		if err != nil {
			return nil, err
		}
		if err := s.chat.CheckMiniAppURL(ctx, target); err != nil {
			return nil, err
		}
		users, err := s.chat.GetUsers(ctx, me, []int64{me})
		if err != nil {
			return nil, err
		}
		if len(users) != 1 {
			return nil, fmt.Errorf("rpc: open mini app: caller %d not found", me)
		}
		initData, err := s.miniApp.Sign(miniapp.InitData{
			BotID:        bot.ID,
			User:         miniapp.User{ID: me, FirstName: users[0].GetName(), Username: users[0].GetUsername()},
			ChatType:     chatType,
			ChatInstance: s.miniApp.ChatInstance(m.GetChatId(), me, bot.ID),
			StartParam:   m.GetStartParam(),
			AuthDate:     time.Now(),
		})
		if err != nil {
			return nil, err
		}
		return &appv1.OpenMiniAppResponse{Url: target, InitData: initData}, nil
	})
}

// AllowMiniAppWrite records the consent the Mini App asked for.
func (s *botsService) AllowMiniAppWrite(ctx context.Context, req *connect.Request[appv1.AllowMiniAppWriteRequest]) (*connect.Response[appv1.AllowMiniAppWriteResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.AllowMiniAppWriteRequest) (*appv1.AllowMiniAppWriteResponse, error) {
		if err := s.chat.AllowBotWrite(ctx, me, m.GetBotId()); err != nil {
			return nil, err
		}
		return &appv1.AllowMiniAppWriteResponse{}, nil
	})
}

// SendMiniAppData posts the Mini App's data to the bot as the caller. The
// server keeps no state of opened Mini Apps, so it cannot tell where this
// one was opened; the client calls it only for a Mini App opened from the
// bot's private chat or profile. Either way the message only goes into the
// caller's own chat with the bot, which the caller may write to anyway.
func (s *botsService) SendMiniAppData(ctx context.Context, req *connect.Request[appv1.SendMiniAppDataRequest]) (*connect.Response[appv1.SendMiniAppDataResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.SendMiniAppDataRequest) (*appv1.SendMiniAppDataResponse, error) {
		if _, err := s.chat.SendMiniAppData(ctx, me, m.GetBotId(), m.GetData(), m.GetButtonText()); err != nil {
			return nil, err
		}
		return &appv1.SendMiniAppDataResponse{}, nil
	})
}

// botAdminService implements BotAdminService (Developer Console). Token
// reveal, deletion and setting the webhook pass the session's IdP auth_time
// for the recent sign-in rule of ADR 0006.
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
	// Whoever held the old token may have set the webhook: it goes with the
	// token, so nothing keeps receiving updates or answering as the bot.
	// Failing here, the owner resets again (the token is already new).
	if bot.GetWebhook() {
		if err := s.updates.DeleteWebhook(ctx, req.Msg.GetBotId(), false); err != nil {
			return nil, fail(ctx, s.logger, req.Spec().Procedure, err)
		}
		bot.Webhook = false
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

// SetBotWebhook needs a recent sign-in like ResetBotToken: the webhook
// receives all of the bot's updates and may send as the bot in its answers.
// (The Bot API's PUT /webhook needs the token itself, which is as much.)
func (s *botAdminService) SetBotWebhook(ctx context.Context, req *connect.Request[appv1.SetBotWebhookRequest]) (*connect.Response[appv1.SetBotWebhookResponse], error) {
	sess, err := mustSession(ctx)
	if err != nil {
		return nil, err
	}
	out, err := s.setWebhook(ctx, sess, req.Msg)
	if err != nil {
		return nil, fail(ctx, s.logger, req.Spec().Procedure, err)
	}
	return connect.NewResponse(out), nil
}

func (s *botAdminService) setWebhook(ctx context.Context, sess store.Session, m *appv1.SetBotWebhookRequest) (*appv1.SetBotWebhookResponse, error) {
	if _, err := s.bots.OwnedRecent(ctx, sess.UserID, sess.AuthTime, m.GetBotId()); err != nil {
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
