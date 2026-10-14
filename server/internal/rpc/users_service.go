package rpc

import (
	"context"
	"errors"
	"log/slog"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/profile"
	"app.local/server/internal/store"
	"connectrpc.com/connect"
)

// usersService implements the self-profile part of UsersService; the other
// methods stay Unimplemented in this release.
type usersService struct {
	appv1connect.UnimplementedUsersServiceHandler
	store    *store.Store
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
