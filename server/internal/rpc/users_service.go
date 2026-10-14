package rpc

import (
	"context"
	"errors"
	"log/slog"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/chat"
	"app.local/server/internal/profile"
	"app.local/server/internal/store"
	"connectrpc.com/connect"
)

// usersService implements UsersService: the self profile on the store,
// lookups, blocks, privacy and reports on the chat core.
type usersService struct {
	appv1connect.UnimplementedUsersServiceHandler
	store    *store.Store
	chat     *chat.Service
	tenantID string
	logger   *slog.Logger
}

// selfUser renders the caller's own user.
func selfUser(u store.User) *appv1.User {
	return &appv1.User{
		Id:       u.ID,
		Username: u.Username,
		Name:     u.Name,
		Bio:      u.Bio,
		IsSelf:   true,
		Email:    u.Email,
	}
}

// GetSelf returns the caller's own user.
func (s *usersService) GetSelf(ctx context.Context, req *connect.Request[appv1.GetSelfRequest]) (*connect.Response[appv1.GetSelfResponse], error) {
	sess, err := mustSession(ctx)
	if err != nil {
		return nil, err
	}
	u, err := s.store.UserByID(ctx, s.tenantID, sess.UserID)
	if err != nil {
		return nil, internal(s.logger, req.Spec().Procedure, err)
	}
	return connect.NewResponse(&appv1.GetSelfResponse{User: selfUser(u)}), nil
}

// UpdateProfile changes the name and/or bio. Profile photos need media
// uploads, which do not exist yet.
func (s *usersService) UpdateProfile(ctx context.Context, req *connect.Request[appv1.UpdateProfileRequest]) (*connect.Response[appv1.UpdateProfileResponse], error) {
	sess, err := mustSession(ctx)
	if err != nil {
		return nil, err
	}
	m := req.Msg
	if m.PhotoFileId != nil && m.GetPhotoFileId() != "" {
		return nil, connect.NewError(connect.CodeUnimplemented, errors.New("profile photos are not supported yet"))
	}
	var name, bio *string
	if m.Name != nil {
		v, err := profile.CleanName(m.GetName())
		if err != nil {
			return nil, connect.NewError(connect.CodeInvalidArgument, err)
		}
		name = &v
	}
	if m.Bio != nil {
		v, err := profile.CleanBio(m.GetBio())
		if err != nil {
			return nil, connect.NewError(connect.CodeInvalidArgument, err)
		}
		bio = &v
	}
	u, err := s.store.UpdateProfile(ctx, s.tenantID, sess.UserID, name, bio)
	if err != nil {
		return nil, internal(s.logger, req.Spec().Procedure, err)
	}
	return connect.NewResponse(&appv1.UpdateProfileResponse{User: selfUser(u)}), nil
}

// SetUsername changes the username; AlreadyExists when another user of the
// tenant has it.
func (s *usersService) SetUsername(ctx context.Context, req *connect.Request[appv1.SetUsernameRequest]) (*connect.Response[appv1.SetUsernameResponse], error) {
	sess, err := mustSession(ctx)
	if err != nil {
		return nil, err
	}
	name := profile.NormalizeUsername(req.Msg.GetUsername())
	if !profile.ValidUsername(name) {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			errors.New("username must be 3 to 32 characters: a-z, 0-9 and _"))
	}
	u, err := s.store.SetUsername(ctx, s.tenantID, sess.UserID, name)
	switch {
	case errors.Is(err, store.ErrUsernameTaken):
		return nil, connect.NewError(connect.CodeAlreadyExists, errors.New("username is taken"))
	case err != nil:
		return nil, internal(s.logger, req.Spec().Procedure, err)
	}
	return connect.NewResponse(&appv1.SetUsernameResponse{User: selfUser(u)}), nil
}

// GetUsers returns users of the tenant with their presence.
func (s *usersService) GetUsers(ctx context.Context, req *connect.Request[appv1.GetUsersRequest]) (*connect.Response[appv1.GetUsersResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.GetUsersRequest) (*appv1.GetUsersResponse, error) {
		users, err := s.chat.GetUsers(ctx, me, m.GetUserIds())
		if err != nil {
			return nil, err
		}
		return &appv1.GetUsersResponse{Users: users}, nil
	})
}

// ResolveUsername finds a user by username.
func (s *usersService) ResolveUsername(ctx context.Context, req *connect.Request[appv1.ResolveUsernameRequest]) (*connect.Response[appv1.ResolveUsernameResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.ResolveUsernameRequest) (*appv1.ResolveUsernameResponse, error) {
		u, err := s.chat.ResolveUsername(ctx, me, m.GetUsername())
		if err != nil {
			return nil, err
		}
		return &appv1.ResolveUsernameResponse{User: u}, nil
	})
}

// SearchUsers searches the tenant's users.
func (s *usersService) SearchUsers(ctx context.Context, req *connect.Request[appv1.SearchUsersRequest]) (*connect.Response[appv1.SearchUsersResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.SearchUsersRequest) (*appv1.SearchUsersResponse, error) {
		users, err := s.chat.SearchUsers(ctx, me, m.GetQuery(), m.GetLimit())
		if err != nil {
			return nil, err
		}
		return &appv1.SearchUsersResponse{Users: users}, nil
	})
}

// Block blocks a user.
func (s *usersService) Block(ctx context.Context, req *connect.Request[appv1.BlockRequest]) (*connect.Response[appv1.BlockResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.BlockRequest) (*appv1.BlockResponse, error) {
		return &appv1.BlockResponse{}, s.chat.Block(ctx, me, m.GetUserId())
	})
}

// Unblock removes a block.
func (s *usersService) Unblock(ctx context.Context, req *connect.Request[appv1.UnblockRequest]) (*connect.Response[appv1.UnblockResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.UnblockRequest) (*appv1.UnblockResponse, error) {
		return &appv1.UnblockResponse{}, s.chat.Unblock(ctx, me, m.GetUserId())
	})
}

// GetPrivacy returns the caller's privacy settings.
func (s *usersService) GetPrivacy(ctx context.Context, req *connect.Request[appv1.GetPrivacyRequest]) (*connect.Response[appv1.GetPrivacyResponse], error) {
	return call(ctx, s.logger, req, func(me int64, _ *appv1.GetPrivacyRequest) (*appv1.GetPrivacyResponse, error) {
		p, err := s.chat.GetPrivacy(ctx, me)
		if err != nil {
			return nil, err
		}
		return &appv1.GetPrivacyResponse{Settings: p}, nil
	})
}

// SetPrivacy changes privacy settings.
func (s *usersService) SetPrivacy(ctx context.Context, req *connect.Request[appv1.SetPrivacyRequest]) (*connect.Response[appv1.SetPrivacyResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.SetPrivacyRequest) (*appv1.SetPrivacyResponse, error) {
		p, err := s.chat.SetPrivacy(ctx, me, m)
		if err != nil {
			return nil, err
		}
		return &appv1.SetPrivacyResponse{Settings: p}, nil
	})
}

// Report files a report into the moderation queue.
func (s *usersService) Report(ctx context.Context, req *connect.Request[appv1.ReportRequest]) (*connect.Response[appv1.ReportResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.ReportRequest) (*appv1.ReportResponse, error) {
		return &appv1.ReportResponse{}, s.chat.Report(ctx, me, m)
	})
}
