package rpc

import (
	"context"
	"log/slog"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/chat"
	"connectrpc.com/connect"
)

// chatsService implements ChatsService on the chat core.
type chatsService struct {
	appv1connect.UnimplementedChatsServiceHandler
	chat   *chat.Service
	logger *slog.Logger
}

// call runs fn for the caller's user id and maps its error.
func call[Req, Resp any](ctx context.Context, logger *slog.Logger, req *connect.Request[Req],
	fn func(me int64, msg *Req) (*Resp, error),
) (*connect.Response[Resp], error) {
	sess, err := mustSession(ctx)
	if err != nil {
		return nil, err
	}
	resp, err := fn(sess.UserID, req.Msg)
	if err != nil {
		return nil, fail(logger, req.Spec().Procedure, err)
	}
	return connect.NewResponse(resp), nil
}

func (s *chatsService) CreatePrivate(ctx context.Context, req *connect.Request[appv1.CreatePrivateRequest]) (*connect.Response[appv1.CreatePrivateResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.CreatePrivateRequest) (*appv1.CreatePrivateResponse, error) {
		c, users, err := s.chat.CreatePrivate(ctx, me, m.GetUserId())
		if err != nil {
			return nil, err
		}
		return &appv1.CreatePrivateResponse{Chat: c, Users: users}, nil
	})
}

func (s *chatsService) CreateGroup(ctx context.Context, req *connect.Request[appv1.CreateGroupRequest]) (*connect.Response[appv1.CreateGroupResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.CreateGroupRequest) (*appv1.CreateGroupResponse, error) {
		return s.chat.CreateGroup(ctx, me, m.GetTitle(), m.GetUserIds(), m.GetForum())
	})
}

func (s *chatsService) CreateChannel(ctx context.Context, req *connect.Request[appv1.CreateChannelRequest]) (*connect.Response[appv1.CreateChannelResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.CreateChannelRequest) (*appv1.CreateChannelResponse, error) {
		return s.chat.CreateChannel(ctx, me, m.GetTitle(), m.GetAbout())
	})
}

func (s *chatsService) GetDialogs(ctx context.Context, req *connect.Request[appv1.GetDialogsRequest]) (*connect.Response[appv1.GetDialogsResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.GetDialogsRequest) (*appv1.GetDialogsResponse, error) {
		return s.chat.GetDialogs(ctx, me, m.GetCursor(), m.GetLimit())
	})
}

func (s *chatsService) GetPeerDialogs(ctx context.Context, req *connect.Request[appv1.GetPeerDialogsRequest]) (*connect.Response[appv1.GetPeerDialogsResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.GetPeerDialogsRequest) (*appv1.GetPeerDialogsResponse, error) {
		return s.chat.GetPeerDialogs(ctx, me, m.GetChatIds())
	})
}

func (s *chatsService) GetChat(ctx context.Context, req *connect.Request[appv1.GetChatRequest]) (*connect.Response[appv1.GetChatResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.GetChatRequest) (*appv1.GetChatResponse, error) {
		c, users, err := s.chat.GetChat(ctx, me, m.GetChatId())
		if err != nil {
			return nil, err
		}
		return &appv1.GetChatResponse{Chat: c, Users: users}, nil
	})
}

func (s *chatsService) GetMembers(ctx context.Context, req *connect.Request[appv1.GetMembersRequest]) (*connect.Response[appv1.GetMembersResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.GetMembersRequest) (*appv1.GetMembersResponse, error) {
		return s.chat.GetMembers(ctx, me, m.GetChatId(), m.GetQuery(), m.GetCursor(), m.GetLimit())
	})
}

func (s *chatsService) AddMembers(ctx context.Context, req *connect.Request[appv1.AddMembersRequest]) (*connect.Response[appv1.AddMembersResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.AddMembersRequest) (*appv1.AddMembersResponse, error) {
		failed, ack, err := s.chat.AddMembers(ctx, me, m.GetChatId(), m.GetUserIds())
		if err != nil {
			return nil, err
		}
		return &appv1.AddMembersResponse{FailedUserIds: failed, Ack: ack}, nil
	})
}

func (s *chatsService) RemoveMember(ctx context.Context, req *connect.Request[appv1.RemoveMemberRequest]) (*connect.Response[appv1.RemoveMemberResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.RemoveMemberRequest) (*appv1.RemoveMemberResponse, error) {
		ack, err := s.chat.RemoveMember(ctx, me, m.GetChatId(), m.GetUserId())
		if err != nil {
			return nil, err
		}
		return &appv1.RemoveMemberResponse{Ack: ack}, nil
	})
}

func (s *chatsService) LeaveChat(ctx context.Context, req *connect.Request[appv1.LeaveChatRequest]) (*connect.Response[appv1.LeaveChatResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.LeaveChatRequest) (*appv1.LeaveChatResponse, error) {
		ack, err := s.chat.LeaveChat(ctx, me, m.GetChatId())
		if err != nil {
			return nil, err
		}
		return &appv1.LeaveChatResponse{Ack: ack}, nil
	})
}

func (s *chatsService) SetMemberPermissions(ctx context.Context, req *connect.Request[appv1.SetMemberPermissionsRequest]) (*connect.Response[appv1.SetMemberPermissionsResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.SetMemberPermissionsRequest) (*appv1.SetMemberPermissionsResponse, error) {
		ack, err := s.chat.SetMemberPermissions(ctx, me, m.GetChatId(), m.GetUserId(), m.GetPermissions())
		if err != nil {
			return nil, err
		}
		return &appv1.SetMemberPermissionsResponse{Ack: ack}, nil
	})
}

func (s *chatsService) SetAdmin(ctx context.Context, req *connect.Request[appv1.SetAdminRequest]) (*connect.Response[appv1.SetAdminResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.SetAdminRequest) (*appv1.SetAdminResponse, error) {
		ack, err := s.chat.SetAdmin(ctx, me, m.GetChatId(), m.GetUserId(), m.GetAdmin())
		if err != nil {
			return nil, err
		}
		return &appv1.SetAdminResponse{Ack: ack}, nil
	})
}

func (s *chatsService) ExportInviteLink(ctx context.Context, req *connect.Request[appv1.ExportInviteLinkRequest]) (*connect.Response[appv1.ExportInviteLinkResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.ExportInviteLinkRequest) (*appv1.ExportInviteLinkResponse, error) {
		inv, err := s.chat.ExportInviteLink(ctx, me, m.GetChatId(), m.GetExpiresAt(), m.GetUsageLimit())
		if err != nil {
			return nil, err
		}
		return &appv1.ExportInviteLinkResponse{Invite: inv}, nil
	})
}

func (s *chatsService) GetInviteLinks(ctx context.Context, req *connect.Request[appv1.GetInviteLinksRequest]) (*connect.Response[appv1.GetInviteLinksResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.GetInviteLinksRequest) (*appv1.GetInviteLinksResponse, error) {
		list, err := s.chat.GetInviteLinks(ctx, me, m.GetChatId())
		if err != nil {
			return nil, err
		}
		return &appv1.GetInviteLinksResponse{Invites: list}, nil
	})
}

func (s *chatsService) RevokeInviteLink(ctx context.Context, req *connect.Request[appv1.RevokeInviteLinkRequest]) (*connect.Response[appv1.RevokeInviteLinkResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.RevokeInviteLinkRequest) (*appv1.RevokeInviteLinkResponse, error) {
		inv, err := s.chat.RevokeInviteLink(ctx, me, m.GetChatId(), m.GetLink())
		if err != nil {
			return nil, err
		}
		return &appv1.RevokeInviteLinkResponse{Invite: inv}, nil
	})
}

func (s *chatsService) CheckInvite(ctx context.Context, req *connect.Request[appv1.CheckInviteRequest]) (*connect.Response[appv1.CheckInviteResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.CheckInviteRequest) (*appv1.CheckInviteResponse, error) {
		return s.chat.CheckInvite(ctx, me, m.GetLink())
	})
}

func (s *chatsService) JoinByInvite(ctx context.Context, req *connect.Request[appv1.JoinByInviteRequest]) (*connect.Response[appv1.JoinByInviteResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.JoinByInviteRequest) (*appv1.JoinByInviteResponse, error) {
		return s.chat.JoinByInvite(ctx, me, m.GetLink())
	})
}

func (s *chatsService) SetHistoryVisibility(ctx context.Context, req *connect.Request[appv1.SetHistoryVisibilityRequest]) (*connect.Response[appv1.SetHistoryVisibilityResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.SetHistoryVisibilityRequest) (*appv1.SetHistoryVisibilityResponse, error) {
		ack, err := s.chat.SetHistoryVisibility(ctx, me, m.GetChatId(), m.GetHistoryVisibility())
		if err != nil {
			return nil, err
		}
		return &appv1.SetHistoryVisibilityResponse{Ack: ack}, nil
	})
}

func (s *chatsService) UpdateChatInfo(ctx context.Context, req *connect.Request[appv1.UpdateChatInfoRequest]) (*connect.Response[appv1.UpdateChatInfoResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.UpdateChatInfoRequest) (*appv1.UpdateChatInfoResponse, error) {
		return s.chat.UpdateChatInfo(ctx, me, m)
	})
}

func (s *chatsService) GetForumTopics(ctx context.Context, req *connect.Request[appv1.GetForumTopicsRequest]) (*connect.Response[appv1.GetForumTopicsResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.GetForumTopicsRequest) (*appv1.GetForumTopicsResponse, error) {
		return s.chat.GetForumTopics(ctx, me, m.GetChatId())
	})
}

func (s *chatsService) CreateForumTopic(ctx context.Context, req *connect.Request[appv1.CreateForumTopicRequest]) (*connect.Response[appv1.CreateForumTopicResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.CreateForumTopicRequest) (*appv1.CreateForumTopicResponse, error) {
		topic, ack, err := s.chat.CreateForumTopic(ctx, me, m.GetChatId(), m.GetTitle(), m.GetIconColor())
		if err != nil {
			return nil, err
		}
		return &appv1.CreateForumTopicResponse{Topic: topic, Ack: ack}, nil
	})
}

func (s *chatsService) EditForumTopic(ctx context.Context, req *connect.Request[appv1.EditForumTopicRequest]) (*connect.Response[appv1.EditForumTopicResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.EditForumTopicRequest) (*appv1.EditForumTopicResponse, error) {
		topic, ack, err := s.chat.EditForumTopic(ctx, me, m)
		if err != nil {
			return nil, err
		}
		return &appv1.EditForumTopicResponse{Topic: topic, Ack: ack}, nil
	})
}

func (s *chatsService) CloseForumTopic(ctx context.Context, req *connect.Request[appv1.CloseForumTopicRequest]) (*connect.Response[appv1.CloseForumTopicResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.CloseForumTopicRequest) (*appv1.CloseForumTopicResponse, error) {
		topic, ack, err := s.chat.CloseForumTopic(ctx, me, m.GetChatId(), m.GetTopicId(), m.GetClosed())
		if err != nil {
			return nil, err
		}
		return &appv1.CloseForumTopicResponse{Topic: topic, Ack: ack}, nil
	})
}

func (s *chatsService) HideForumTopic(ctx context.Context, req *connect.Request[appv1.HideForumTopicRequest]) (*connect.Response[appv1.HideForumTopicResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.HideForumTopicRequest) (*appv1.HideForumTopicResponse, error) {
		topic, ack, err := s.chat.HideForumTopic(ctx, me, m.GetChatId(), m.GetTopicId(), m.GetHidden())
		if err != nil {
			return nil, err
		}
		return &appv1.HideForumTopicResponse{Topic: topic, Ack: ack}, nil
	})
}
