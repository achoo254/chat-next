package rpc

import (
	"app.local/server/internal/bridge/feature"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/botadmin"
	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/engine"
	"app.local/server/internal/chat"
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

// bridgeCall runs fn for the signed-in user. Only the calls that cannot be
// undone in the other app (leaving or deleting a group there) pass recent: the
// session's IdP sign-in must be recent (the same rule as resetting a bot token).
// The login steps do not: connecting an account already needs the other app's
// own proof (its code and password, or a scan confirmed on the phone), so a
// second sign-in to Chat only stood in the way.
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
	case errors.Is(err, engine.ErrSendUnsupported):
		return connect.NewError(connect.CodeFailedPrecondition, errors.New("send_unsupported: this app cannot be written to from Chat, or the account is signed out"))
	case errors.Is(err, engine.ErrFeatureOff):
		return connect.NewError(connect.CodeFailedPrecondition, errors.New("feature_off: this is not turned on to send for the chat"))
	case errors.Is(err, engine.ErrConfirmation):
		return connect.NewError(connect.CodeInvalidArgument, errors.New("confirmation_wrong: the name or the confirmation is not right"))
	case errors.Is(err, engine.ErrFeatureUnsupported):
		return connect.NewError(connect.CodeFailedPrecondition, errors.New("feature_unsupported: this app cannot do that"))
	case errors.Is(err, engine.ErrRateLimited):
		// retry_after is the wait the limit asks for in seconds; the page counts it down.
		if wait := bridge.LoginWait(err); wait > 0 {
			return connect.NewError(connect.CodeResourceExhausted, fmt.Errorf("rate_limited: too many sign-in attempts; retry_after=%d", wait))
		}
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

func (s *bridgeService) StartBridgeSync(ctx context.Context, req *connect.Request[appv1.StartBridgeSyncRequest]) (*connect.Response[appv1.StartBridgeSyncResponse], error) {
	return bridgeCall(ctx, s, req, false, func(me int64, m *appv1.StartBridgeSyncRequest) (*appv1.StartBridgeSyncResponse, error) {
		if err := s.engine.StartSync(ctx, me, m.GetAccountId()); err != nil {
			return nil, err
		}
		return &appv1.StartBridgeSyncResponse{}, nil
	})
}

func (s *bridgeService) StartBridgeLogin(ctx context.Context, req *connect.Request[appv1.StartBridgeLoginRequest]) (*connect.Response[appv1.StartBridgeLoginResponse], error) {
	return bridgeCall(ctx, s, req, false, func(me int64, m *appv1.StartBridgeLoginRequest) (*appv1.StartBridgeLoginResponse, error) {
		step, err := s.engine.StartLogin(ctx, me, m.GetSource())
		if err != nil {
			return nil, err
		}
		return &appv1.StartBridgeLoginResponse{Step: stepMessage(step)}, nil
	})
}

func (s *bridgeService) ContinueBridgeLogin(ctx context.Context, req *connect.Request[appv1.ContinueBridgeLoginRequest]) (*connect.Response[appv1.ContinueBridgeLoginResponse], error) {
	return bridgeCall(ctx, s, req, false, func(me int64, m *appv1.ContinueBridgeLoginRequest) (*appv1.ContinueBridgeLoginResponse, error) {
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

func (s *bridgeService) ListBridgeConversations(_ context.Context, _ *connect.Request[appv1.ListBridgeConversationsRequest]) (*connect.Response[appv1.ListBridgeConversationsResponse], error) {
	return nil, errRetired("ListBridgeConversations")
}

func (s *bridgeService) EnableBridgeChat(_ context.Context, _ *connect.Request[appv1.EnableBridgeChatRequest]) (*connect.Response[appv1.EnableBridgeChatResponse], error) {
	return nil, errRetired("EnableBridgeChat")
}

func (s *bridgeService) RemoveBridgeChat(_ context.Context, _ *connect.Request[appv1.RemoveBridgeChatRequest]) (*connect.Response[appv1.RemoveBridgeChatResponse], error) {
	return nil, errRetired("RemoveBridgeChat")
}

func (s *bridgeService) SetBridgeChatDirection(_ context.Context, _ *connect.Request[appv1.SetBridgeChatDirectionRequest]) (*connect.Response[appv1.SetBridgeChatDirectionResponse], error) {
	return nil, errRetired("SetBridgeChatDirection")
}

func riskName(r feature.Risk) string {
	switch r {
	case feature.R2:
		return "r2"
	case feature.R3:
		return "r3"
	case feature.RE:
		return "re"
	}
	return "r1"
}

func (s *bridgeService) ListBridgeFeatures(ctx context.Context, req *connect.Request[appv1.ListBridgeFeaturesRequest]) (*connect.Response[appv1.ListBridgeFeaturesResponse], error) {
	return bridgeCall(ctx, s, req, false, func(me int64, m *appv1.ListBridgeFeaturesRequest) (*appv1.ListBridgeFeaturesResponse, error) {
		views, err := s.engine.Features(ctx, me, m.GetAccountId(), m.GetConversationId())
		if err != nil {
			return nil, err
		}
		resp := &appv1.ListBridgeFeaturesResponse{}
		for _, v := range views {
			resp.Features = append(resp.Features, &appv1.BridgeFeature{
				Feature: string(v.Feature), Risk: riskName(v.Risk), Direction: string(v.Direction), IsDefault: v.Default,
				CanReceive: v.Supported.In, CanSend: v.Supported.Out,
			})
		}
		return resp, nil
	})
}

func (s *bridgeService) SetBridgeFeature(_ context.Context, _ *connect.Request[appv1.SetBridgeFeatureRequest]) (*connect.Response[appv1.SetBridgeFeatureResponse], error) {
	return nil, errRetired("SetBridgeFeature")
}

func (s *bridgeService) ListBridgeInvites(ctx context.Context, req *connect.Request[appv1.ListBridgeInvitesRequest]) (*connect.Response[appv1.ListBridgeInvitesResponse], error) {
	return bridgeCall(ctx, s, req, false, func(me int64, m *appv1.ListBridgeInvitesRequest) (*appv1.ListBridgeInvitesResponse, error) {
		list, err := s.engine.Invites(ctx, me, m.GetAccountId(), m.GetConversationId())
		if err != nil {
			return nil, err
		}
		resp := &appv1.ListBridgeInvitesResponse{}
		for _, v := range list {
			resp.Invites = append(resp.Invites, &appv1.BridgeInvite{Link: v.Link, Title: v.Title, Revoked: v.Revoked, Usage: int32(v.Usage)})
		}
		return resp, nil
	})
}

func (s *bridgeService) CreateBridgeInvite(ctx context.Context, req *connect.Request[appv1.CreateBridgeInviteRequest]) (*connect.Response[appv1.CreateBridgeInviteResponse], error) {
	return bridgeCall(ctx, s, req, false, func(me int64, m *appv1.CreateBridgeInviteRequest) (*appv1.CreateBridgeInviteResponse, error) {
		if err := s.engine.CreateInvite(ctx, me, m.GetAccountId(), m.GetConversationId(), m.GetTitle()); err != nil {
			return nil, err
		}
		return &appv1.CreateBridgeInviteResponse{}, nil
	})
}

func (s *bridgeService) RevokeBridgeInvite(ctx context.Context, req *connect.Request[appv1.RevokeBridgeInviteRequest]) (*connect.Response[appv1.RevokeBridgeInviteResponse], error) {
	return bridgeCall(ctx, s, req, false, func(me int64, m *appv1.RevokeBridgeInviteRequest) (*appv1.RevokeBridgeInviteResponse, error) {
		if err := s.engine.RevokeInvite(ctx, me, m.GetAccountId(), m.GetConversationId(), m.GetLink()); err != nil {
			return nil, err
		}
		return &appv1.RevokeBridgeInviteResponse{}, nil
	})
}

func (s *bridgeService) ListBridgeCandidates(ctx context.Context, req *connect.Request[appv1.ListBridgeCandidatesRequest]) (*connect.Response[appv1.ListBridgeCandidatesResponse], error) {
	return bridgeCall(ctx, s, req, false, func(me int64, m *appv1.ListBridgeCandidatesRequest) (*appv1.ListBridgeCandidatesResponse, error) {
		list, err := s.engine.Candidates(ctx, me, m.GetAccountId(), m.GetConversationId())
		if err != nil {
			return nil, err
		}
		resp := &appv1.ListBridgeCandidatesResponse{}
		for _, c := range list {
			resp.Candidates = append(resp.Candidates, &appv1.BridgeCandidate{ParticipantId: c.ParticipantID, Name: c.Name})
		}
		return resp, nil
	})
}

func (s *bridgeService) AddBridgeMember(ctx context.Context, req *connect.Request[appv1.AddBridgeMemberRequest]) (*connect.Response[appv1.AddBridgeMemberResponse], error) {
	return bridgeCall(ctx, s, req, false, func(me int64, m *appv1.AddBridgeMemberRequest) (*appv1.AddBridgeMemberResponse, error) {
		if err := s.engine.AddMember(ctx, me, m.GetAccountId(), m.GetConversationId(), m.GetParticipantId()); err != nil {
			return nil, err
		}
		return &appv1.AddBridgeMemberResponse{}, nil
	})
}

func (s *bridgeService) LeaveBridgeGroup(ctx context.Context, req *connect.Request[appv1.LeaveBridgeGroupRequest]) (*connect.Response[appv1.LeaveBridgeGroupResponse], error) {
	return bridgeCall(ctx, s, req, true, func(me int64, m *appv1.LeaveBridgeGroupRequest) (*appv1.LeaveBridgeGroupResponse, error) {
		if err := s.engine.LeaveGroup(ctx, me, m.GetAccountId(), m.GetConversationId(), m.GetConfirmName()); err != nil {
			return nil, err
		}
		return &appv1.LeaveBridgeGroupResponse{}, nil
	})
}

func (s *bridgeService) RequestBridgeGroupDelete(ctx context.Context, req *connect.Request[appv1.RequestBridgeGroupDeleteRequest]) (*connect.Response[appv1.RequestBridgeGroupDeleteResponse], error) {
	return bridgeCall(ctx, s, req, true, func(me int64, m *appv1.RequestBridgeGroupDeleteRequest) (*appv1.RequestBridgeGroupDeleteResponse, error) {
		token, from, until, err := s.engine.RequestGroupDelete(ctx, me, m.GetAccountId(), m.GetConversationId(), m.GetConfirmName())
		if err != nil {
			return nil, err
		}
		return &appv1.RequestBridgeGroupDeleteResponse{Token: token, UsableFromUnix: from.Unix(), ExpiresUnix: until.Unix()}, nil
	})
}

func (s *bridgeService) DeleteBridgeGroup(ctx context.Context, req *connect.Request[appv1.DeleteBridgeGroupRequest]) (*connect.Response[appv1.DeleteBridgeGroupResponse], error) {
	return bridgeCall(ctx, s, req, true, func(me int64, m *appv1.DeleteBridgeGroupRequest) (*appv1.DeleteBridgeGroupResponse, error) {
		if err := s.engine.DeleteGroup(ctx, me, m.GetAccountId(), m.GetConversationId(), m.GetConfirmName(), m.GetToken()); err != nil {
			return nil, err
		}
		return &appv1.DeleteBridgeGroupResponse{}, nil
	})
}

func (s *bridgeService) ListBridgeOutbox(ctx context.Context, req *connect.Request[appv1.ListBridgeOutboxRequest]) (*connect.Response[appv1.ListBridgeOutboxResponse], error) {
	return bridgeCall(ctx, s, req, false, func(me int64, m *appv1.ListBridgeOutboxRequest) (*appv1.ListBridgeOutboxResponse, error) {
		items, err := s.engine.Outbox(ctx, me, m.GetChatId())
		if err != nil {
			return nil, err
		}
		resp := &appv1.ListBridgeOutboxResponse{}
		for _, it := range items {
			resp.Items = append(resp.Items, &appv1.BridgeOutboxItem{
				Seq: it.Seq, Op: it.Op, Status: outboxStatus(it.Status), LastError: it.LastError, Attempts: int32(it.Attempts),
			})
		}
		return resp, nil
	})
}

func (s *bridgeService) RetryBridgeMessage(ctx context.Context, req *connect.Request[appv1.RetryBridgeMessageRequest]) (*connect.Response[appv1.RetryBridgeMessageResponse], error) {
	return bridgeCall(ctx, s, req, false, func(me int64, m *appv1.RetryBridgeMessageRequest) (*appv1.RetryBridgeMessageResponse, error) {
		if err := s.engine.RetryMessage(ctx, me, m.GetChatId(), m.GetSeq()); err != nil {
			return nil, err
		}
		return &appv1.RetryBridgeMessageResponse{}, nil
	})
}

func (s *bridgeService) DismissBridgeMessage(ctx context.Context, req *connect.Request[appv1.DismissBridgeMessageRequest]) (*connect.Response[appv1.DismissBridgeMessageResponse], error) {
	return bridgeCall(ctx, s, req, false, func(me int64, m *appv1.DismissBridgeMessageRequest) (*appv1.DismissBridgeMessageResponse, error) {
		if err := s.engine.DismissMessage(ctx, me, m.GetChatId(), m.GetSeq()); err != nil {
			return nil, err
		}
		return &appv1.DismissBridgeMessageResponse{}, nil
	})
}

func (s *bridgeService) DisconnectBridgeAccount(ctx context.Context, req *connect.Request[appv1.DisconnectBridgeAccountRequest]) (*connect.Response[appv1.DisconnectBridgeAccountResponse], error) {
	return bridgeCall(ctx, s, req, false, func(me int64, m *appv1.DisconnectBridgeAccountRequest) (*appv1.DisconnectBridgeAccountResponse, error) {
		if err := s.engine.Disconnect(ctx, me, m.GetAccountId(), m.GetDeleteChats()); err != nil {
			return nil, err
		}
		return &appv1.DisconnectBridgeAccountResponse{}, nil
	})
}

func accountMessage(a engine.AccountView) *appv1.BridgeAccount {
	out := &appv1.BridgeAccount{Id: a.ID, Source: a.Source, LastError: a.LastError, Progress: &appv1.BridgeSyncProgress{
		Conversations: int32(a.Progress.Conversations), ConversationsDone: int32(a.Progress.Done),
		Messages: a.Progress.Messages, MessagesExpected: a.Progress.Expected,
	}}
	switch a.SyncState {
	case engine.SyncSyncing:
		out.SyncState = appv1.BridgeSyncState_BRIDGE_SYNC_STATE_SYNCING
	case engine.SyncLive:
		out.SyncState = appv1.BridgeSyncState_BRIDGE_SYNC_STATE_LIVE
	default:
		out.SyncState = appv1.BridgeSyncState_BRIDGE_SYNC_STATE_OFF
	}
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
			Direction: directionMessage(c.Direction), TopicsSplit: c.TopicsSplit,
		})
	}
	return out
}

func directionMessage(d string) appv1.BridgeDirection {
	switch d {
	case chat.DirectionBoth:
		return appv1.BridgeDirection_BRIDGE_DIRECTION_BOTH
	case chat.DirectionIn:
		return appv1.BridgeDirection_BRIDGE_DIRECTION_IN
	}
	return appv1.BridgeDirection_BRIDGE_DIRECTION_UNSPECIFIED
}

func outboxStatus(s string) appv1.BridgeOutboxStatus {
	switch s {
	case "pending":
		return appv1.BridgeOutboxStatus_BRIDGE_OUTBOX_STATUS_PENDING
	case "sending":
		return appv1.BridgeOutboxStatus_BRIDGE_OUTBOX_STATUS_SENDING
	case "failed":
		return appv1.BridgeOutboxStatus_BRIDGE_OUTBOX_STATUS_FAILED
	case "unknown":
		return appv1.BridgeOutboxStatus_BRIDGE_OUTBOX_STATUS_UNKNOWN
	}
	return appv1.BridgeOutboxStatus_BRIDGE_OUTBOX_STATUS_UNSPECIFIED
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

func (s *bridgeService) ListBridgeFeatureDefaults(_ context.Context, _ *connect.Request[appv1.ListBridgeFeatureDefaultsRequest]) (*connect.Response[appv1.ListBridgeFeatureDefaultsResponse], error) {
	return nil, errRetired("ListBridgeFeatureDefaults")
}

func (s *bridgeService) SetBridgeFeatureDefault(_ context.Context, _ *connect.Request[appv1.SetBridgeFeatureDefaultRequest]) (*connect.Response[appv1.SetBridgeFeatureDefaultResponse], error) {
	return nil, errRetired("SetBridgeFeatureDefault")
}

func (s *bridgeService) ListBridgeProblems(ctx context.Context, req *connect.Request[appv1.ListBridgeProblemsRequest]) (*connect.Response[appv1.ListBridgeProblemsResponse], error) {
	return bridgeCall(ctx, s, req, false, func(me int64, m *appv1.ListBridgeProblemsRequest) (*appv1.ListBridgeProblemsResponse, error) {
		list, err := s.engine.Problems(ctx, me, m.GetAccountId())
		if err != nil {
			return nil, err
		}
		resp := &appv1.ListBridgeProblemsResponse{}
		for _, v := range list {
			resp.Problems = append(resp.Problems, &appv1.BridgeProblem{
				Id: v.ID, ChatId: v.ChatID, ChatTitle: v.ChatTitle, Feature: v.Feature, Op: v.Op, Seq: v.Seq,
				Status: v.Status, LastError: v.LastError, Attempts: int32(v.Attempts), AtUnix: v.At.Unix(),
			})
		}
		return resp, nil
	})
}

func (s *bridgeService) RetryBridgeProblem(ctx context.Context, req *connect.Request[appv1.RetryBridgeProblemRequest]) (*connect.Response[appv1.RetryBridgeProblemResponse], error) {
	return bridgeCall(ctx, s, req, false, func(me int64, m *appv1.RetryBridgeProblemRequest) (*appv1.RetryBridgeProblemResponse, error) {
		if err := s.engine.RetryProblem(ctx, me, m.GetAccountId(), m.GetId()); err != nil {
			return nil, err
		}
		return &appv1.RetryBridgeProblemResponse{}, nil
	})
}

func (s *bridgeService) DismissBridgeProblem(ctx context.Context, req *connect.Request[appv1.DismissBridgeProblemRequest]) (*connect.Response[appv1.DismissBridgeProblemResponse], error) {
	return bridgeCall(ctx, s, req, false, func(me int64, m *appv1.DismissBridgeProblemRequest) (*appv1.DismissBridgeProblemResponse, error) {
		if err := s.engine.DismissProblem(ctx, me, m.GetAccountId(), m.GetId()); err != nil {
			return nil, err
		}
		return &appv1.DismissBridgeProblemResponse{}, nil
	})
}

// errRetired answers a call the one-switch sync retired (ADR 0024): choosing chats,
// history sizes, directions and features is gone; StartBridgeSync does all of it.
func errRetired(name string) error {
	return connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("removed: %s was retired by the one-switch sync (ADR 0024)", name))
}
