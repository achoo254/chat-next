package rpc

import (
	"context"
	"errors"
	"log/slog"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/botadmin"
	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/engine"
	"connectrpc.com/connect"
)

// bridgeService implements BridgeService: the user connects an account of
// another app and chooses which conversations Chat copies in (ADR 0022).
// engine is nil when the bridge is off.
type bridgeService struct {
	appv1connect.UnimplementedBridgeServiceHandler
	engine *engine.Engine
	logger *slog.Logger
}

// bridgeCall runs fn for the signed-in user. Calls that change something
// pass recent: the session's IdP sign-in must be recent (the same rule as
// resetting a bot token), because a connected account reads the user's
// private conversations.
func bridgeCall[Req, Resp any](ctx context.Context, s *bridgeService, req *connect.Request[Req], recent bool,
	fn func(me int64, msg *Req) (*Resp, error),
) (*connect.Response[Resp], error) {
	if s.engine == nil {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("bridge_disabled: the Chat Bridge is not turned on"))
	}
	sess, err := mustSession(ctx)
	if err != nil {
		return nil, err
	}
	if recent && (sess.AuthTime.IsZero() || time.Since(sess.AuthTime) > botadmin.RecentSignIn) {
		return nil, connect.NewError(connect.CodeFailedPrecondition,
			errors.New("reauth_required: sign in again (within the last 10 minutes) to do this"))
	}
	resp, err := fn(sess.UserID, req.Msg)
	if err != nil {
		return nil, fail(ctx, s.logger, req.Spec().Procedure, bridgeError(err))
	}
	return connect.NewResponse(resp), nil
}

// bridgeError maps the errors of the engine to Connect codes.
func bridgeError(err error) error {
	var wrong *bridge.InputError
	switch {
	case errors.As(err, &wrong):
		return connect.NewError(connect.CodeInvalidArgument, errors.New("wrong_input: "+wrong.Message))
	case errors.Is(err, engine.ErrUnknownApp):
		return connect.NewError(connect.CodeInvalidArgument, errors.New("unknown_app: this app cannot be connected"))
	case errors.Is(err, engine.ErrNotFound):
		return connect.NewError(connect.CodeNotFound, errors.New("not found"))
	case errors.Is(err, engine.ErrRateLimited):
		return connect.NewError(connect.CodeResourceExhausted, errors.New("too many sign-in attempts; try again later"))
	case errors.Is(err, engine.ErrAccountTaken):
		return connect.NewError(connect.CodeAlreadyExists, errors.New("account_taken: this account is connected by another user"))
	default:
		return err
	}
}

func (s *bridgeService) GetBridgeStatus(ctx context.Context, req *connect.Request[appv1.GetBridgeStatusRequest]) (*connect.Response[appv1.GetBridgeStatusResponse], error) {
	return bridgeCall(ctx, s, req, false, func(me int64, _ *appv1.GetBridgeStatusRequest) (*appv1.GetBridgeStatusResponse, error) {
		resp := &appv1.GetBridgeStatusResponse{}
		for _, source := range s.engine.Sources() {
			resp.Apps = append(resp.Apps, &appv1.BridgeApp{Source: source})
		}
		accounts, err := s.engine.Accounts(ctx, me)
		if err != nil {
			return nil, err
		}
		for _, a := range accounts {
			resp.Accounts = append(resp.Accounts, accountMessage(a))
		}
		return resp, nil
	})
}

func (s *bridgeService) StartBridgeLogin(ctx context.Context, req *connect.Request[appv1.StartBridgeLoginRequest]) (*connect.Response[appv1.StartBridgeLoginResponse], error) {
	return bridgeCall(ctx, s, req, true, func(me int64, m *appv1.StartBridgeLoginRequest) (*appv1.StartBridgeLoginResponse, error) {
		step, err := s.engine.StartLogin(ctx, me, m.GetSource())
		if err != nil {
			return nil, err
		}
		return &appv1.StartBridgeLoginResponse{Step: stepMessage(step)}, nil
	})
}

func (s *bridgeService) ContinueBridgeLogin(ctx context.Context, req *connect.Request[appv1.ContinueBridgeLoginRequest]) (*connect.Response[appv1.ContinueBridgeLoginResponse], error) {
	return bridgeCall(ctx, s, req, true, func(me int64, m *appv1.ContinueBridgeLoginRequest) (*appv1.ContinueBridgeLoginResponse, error) {
		step, err := s.engine.ContinueLogin(ctx, me, m.GetLoginId(), m.GetInput())
		if err != nil {
			return nil, err
		}
		out := stepMessage(step)
		if step.Kind == bridge.StepDone {
			accounts, err := s.engine.Accounts(ctx, me)
			if err != nil {
				return nil, err
			}
			for _, a := range accounts {
				if a.ID == step.AccountID {
					out.Account = accountMessage(a)
				}
			}
		}
		return &appv1.ContinueBridgeLoginResponse{Step: out}, nil
	})
}

func (s *bridgeService) ListBridgeConversations(ctx context.Context, req *connect.Request[appv1.ListBridgeConversationsRequest]) (*connect.Response[appv1.ListBridgeConversationsResponse], error) {
	return bridgeCall(ctx, s, req, false, func(me int64, m *appv1.ListBridgeConversationsRequest) (*appv1.ListBridgeConversationsResponse, error) {
		list, err := s.engine.Conversations(ctx, me, m.GetAccountId())
		if err != nil {
			return nil, err
		}
		resp := &appv1.ListBridgeConversationsResponse{}
		for _, c := range list {
			resp.Conversations = append(resp.Conversations, &appv1.BridgeConversation{
				Id: c.ID, Kind: conversationKind(c.Kind), Title: c.Title, ChatId: c.ChatID,
			})
		}
		return resp, nil
	})
}

func (s *bridgeService) EnableBridgeChat(ctx context.Context, req *connect.Request[appv1.EnableBridgeChatRequest]) (*connect.Response[appv1.EnableBridgeChatResponse], error) {
	return bridgeCall(ctx, s, req, true, func(me int64, m *appv1.EnableBridgeChatRequest) (*appv1.EnableBridgeChatResponse, error) {
		window := int(m.GetHistoryWindow())
		if window < 0 || window > engine.MaxWindow {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("history_window must be 0 or 1 to 100000"))
		}
		chatID, err := s.engine.EnableConversation(ctx, me, m.GetAccountId(), m.GetConversationId(), window)
		if err != nil {
			return nil, err
		}
		return &appv1.EnableBridgeChatResponse{ChatId: chatID}, nil
	})
}

func (s *bridgeService) RemoveBridgeChat(ctx context.Context, req *connect.Request[appv1.RemoveBridgeChatRequest]) (*connect.Response[appv1.RemoveBridgeChatResponse], error) {
	return bridgeCall(ctx, s, req, true, func(me int64, m *appv1.RemoveBridgeChatRequest) (*appv1.RemoveBridgeChatResponse, error) {
		if err := s.engine.RemoveChat(ctx, me, m.GetAccountId(), m.GetConversationId()); err != nil {
			return nil, err
		}
		return &appv1.RemoveBridgeChatResponse{}, nil
	})
}

func (s *bridgeService) DisconnectBridgeAccount(ctx context.Context, req *connect.Request[appv1.DisconnectBridgeAccountRequest]) (*connect.Response[appv1.DisconnectBridgeAccountResponse], error) {
	return bridgeCall(ctx, s, req, true, func(me int64, m *appv1.DisconnectBridgeAccountRequest) (*appv1.DisconnectBridgeAccountResponse, error) {
		if err := s.engine.Disconnect(ctx, me, m.GetAccountId(), m.GetDeleteChats()); err != nil {
			return nil, err
		}
		return &appv1.DisconnectBridgeAccountResponse{}, nil
	})
}

func accountMessage(a engine.AccountView) *appv1.BridgeAccount {
	out := &appv1.BridgeAccount{Id: a.ID, Source: a.Source, LastError: a.LastError}
	switch a.Status {
	case "active":
		out.Status = appv1.BridgeAccountStatus_BRIDGE_ACCOUNT_STATUS_ACTIVE
	case "needs_login":
		out.Status = appv1.BridgeAccountStatus_BRIDGE_ACCOUNT_STATUS_NEEDS_LOGIN
	case "stopped":
		out.Status = appv1.BridgeAccountStatus_BRIDGE_ACCOUNT_STATUS_STOPPED
	}
	for _, c := range a.Chats {
		out.Chats = append(out.Chats, &appv1.BridgeSyncedChat{
			ConversationId: c.ConversationID, ChatId: c.ChatID, CaughtUp: c.CaughtUp, HistoryWindow: int32(c.HistoryWindow), Title: c.Title,
		})
	}
	return out
}

func stepMessage(s engine.LoginStep) *appv1.BridgeLoginStep {
	out := &appv1.BridgeLoginStep{LoginId: s.LoginID, Prompt: s.Prompt}
	switch s.Kind {
	case bridge.StepInput:
		out.Kind = appv1.BridgeLoginStepKind_BRIDGE_LOGIN_STEP_KIND_INPUT
	case bridge.StepQR:
		out.Kind = appv1.BridgeLoginStepKind_BRIDGE_LOGIN_STEP_KIND_QR
	case bridge.StepConfirm:
		out.Kind = appv1.BridgeLoginStepKind_BRIDGE_LOGIN_STEP_KIND_CONFIRM
	case bridge.StepDone:
		out.Kind = appv1.BridgeLoginStepKind_BRIDGE_LOGIN_STEP_KIND_DONE
	}
	for _, f := range s.Fields {
		out.Fields = append(out.Fields, &appv1.BridgeLoginField{Name: f.Name, Label: f.Label, Secret: f.Secret})
	}
	return out
}

func conversationKind(k bridge.ConvKind) appv1.BridgeConversationKind {
	switch k {
	case bridge.ConvPrivate:
		return appv1.BridgeConversationKind_BRIDGE_CONVERSATION_KIND_PRIVATE
	case bridge.ConvBot:
		return appv1.BridgeConversationKind_BRIDGE_CONVERSATION_KIND_BOT
	case bridge.ConvGroup:
		return appv1.BridgeConversationKind_BRIDGE_CONVERSATION_KIND_GROUP
	case bridge.ConvChannel:
		return appv1.BridgeConversationKind_BRIDGE_CONVERSATION_KIND_CHANNEL
	}
	return appv1.BridgeConversationKind_BRIDGE_CONVERSATION_KIND_UNSPECIFIED
}
