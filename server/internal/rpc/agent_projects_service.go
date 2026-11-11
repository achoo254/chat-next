package rpc

import (
	"context"
	"errors"
	"log/slog"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/gitremote"
	"app.local/server/internal/store"
	"connectrpc.com/connect"
)

// announceTimeout bounds telling the other sessions about a change.
const announceTimeout = 5 * time.Second

// agentProjectsAnnouncer tells a user's sessions that their projects
// changed (chat.Service).
type agentProjectsAnnouncer interface {
	AnnounceAgentProjectsChanged(ctx context.Context, userID int64) error
}

// agentProjectsService implements AgentProjectsService: the caller's AI
// Agent projects and their workspaces, metadata only. Every call is scoped
// to the caller (tenant and user): another user's rows are not_found.
type agentProjectsService struct {
	appv1connect.UnimplementedAgentProjectsServiceHandler
	store    *store.Store
	announce agentProjectsAnnouncer
	tenantID string
	logger   *slog.Logger
}

func errBadProjectName() error {
	return connect.NewError(connect.CodeInvalidArgument, errors.New("name must be 1 to 64 characters without control characters"))
}

func errProjectNotFound() error {
	return connect.NewError(connect.CodeNotFound, errors.New("project_not_found: project not found"))
}

func errWorkspaceNotFound() error {
	return connect.NewError(connect.CodeNotFound, errors.New("workspace_not_found: workspace not found"))
}

func (s *agentProjectsService) ListAgentProjects(ctx context.Context, req *connect.Request[appv1.ListAgentProjectsRequest]) (*connect.Response[appv1.ListAgentProjectsResponse], error) {
	sess, err := mustSession(ctx)
	if err != nil {
		return nil, err
	}
	projects, err := s.store.ListAgentProjects(ctx, s.tenantID, sess.UserID)
	if err != nil {
		return nil, internal(ctx, s.logger, req.Spec().Procedure, err)
	}
	out := make([]*appv1.AgentProject, len(projects))
	for i, p := range projects {
		out[i] = agentProjectProto(p)
	}
	return connect.NewResponse(&appv1.ListAgentProjectsResponse{Projects: out}), nil
}

func (s *agentProjectsService) CreateAgentProject(ctx context.Context, req *connect.Request[appv1.CreateAgentProjectRequest]) (*connect.Response[appv1.CreateAgentProjectResponse], error) {
	sess, err := mustSession(ctx)
	if err != nil {
		return nil, err
	}
	name, ok := store.CleanAgentProjectName(req.Msg.GetName())
	if !ok {
		return nil, errBadProjectName()
	}
	var remote string
	if raw := req.Msg.GetGitRemote(); raw != "" {
		if remote, ok = gitremote.Canonical(raw); !ok {
			return nil, connect.NewError(connect.CodeInvalidArgument,
				errors.New("git_remote must be a remote URL of a repository (https, ssh or user@host:path)"))
		}
	}
	p, err := s.store.CreateAgentProject(ctx, s.tenantID, sess.UserID, name, remote)
	switch {
	case errors.Is(err, store.ErrAgentProjectRemoteExists):
		return nil, connect.NewError(connect.CodeAlreadyExists, errors.New("project_remote_exists: a project links this repository already"))
	case errors.Is(err, store.ErrTooManyAgentProjects):
		return nil, connect.NewError(connect.CodeResourceExhausted, errors.New("too_many_projects: remove a project first"))
	case errors.Is(err, store.ErrNotFound):
		return nil, errUnauthenticated()
	case err != nil:
		return nil, internal(ctx, s.logger, req.Spec().Procedure, err)
	}
	s.changed(ctx, sess.UserID)
	return connect.NewResponse(&appv1.CreateAgentProjectResponse{Project: agentProjectProto(p)}), nil
}

func (s *agentProjectsService) RenameAgentProject(ctx context.Context, req *connect.Request[appv1.RenameAgentProjectRequest]) (*connect.Response[appv1.RenameAgentProjectResponse], error) {
	sess, err := mustSession(ctx)
	if err != nil {
		return nil, err
	}
	name, ok := store.CleanAgentProjectName(req.Msg.GetName())
	if !ok {
		return nil, errBadProjectName()
	}
	p, err := s.store.RenameAgentProject(ctx, s.tenantID, sess.UserID, req.Msg.GetProjectId(), name)
	switch {
	case errors.Is(err, store.ErrNotFound):
		return nil, errProjectNotFound()
	case err != nil:
		return nil, internal(ctx, s.logger, req.Spec().Procedure, err)
	}
	s.changed(ctx, sess.UserID)
	return connect.NewResponse(&appv1.RenameAgentProjectResponse{Project: agentProjectProto(p)}), nil
}

func (s *agentProjectsService) DeleteAgentProject(ctx context.Context, req *connect.Request[appv1.DeleteAgentProjectRequest]) (*connect.Response[appv1.DeleteAgentProjectResponse], error) {
	sess, err := mustSession(ctx)
	if err != nil {
		return nil, err
	}
	err = s.store.DeleteAgentProject(ctx, s.tenantID, sess.UserID, req.Msg.GetProjectId())
	switch {
	case errors.Is(err, store.ErrNotFound):
		return nil, errProjectNotFound()
	case err != nil:
		return nil, internal(ctx, s.logger, req.Spec().Procedure, err)
	}
	s.changed(ctx, sess.UserID)
	return connect.NewResponse(&appv1.DeleteAgentProjectResponse{}), nil
}

func (s *agentProjectsService) AttachAgentWorkspace(ctx context.Context, req *connect.Request[appv1.AttachAgentWorkspaceRequest]) (*connect.Response[appv1.AttachAgentWorkspaceResponse], error) {
	sess, err := mustSession(ctx)
	if err != nil {
		return nil, err
	}
	m := req.Msg
	if !store.CleanAgentWorkspaceDir(m.GetDir()) {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			errors.New("dir must be an absolute path of up to 1024 characters without control characters"))
	}
	if !store.CleanAgentWorkspaceBranch(m.GetBranch()) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("branch must be up to 255 characters without control characters"))
	}
	kind, ok := workspaceKindName(m.GetKind())
	if !ok {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("kind must be CLONE, WORKTREE or FOLDER"))
	}
	w, err := s.store.AttachAgentWorkspace(ctx, s.tenantID, sess.UserID, store.NewAgentWorkspace{
		ProjectID: m.GetProjectId(), MachineID: m.GetMachineId(), Dir: m.GetDir(), Branch: m.GetBranch(), Kind: kind,
	})
	switch {
	case errors.Is(err, store.ErrAgentProjectNotFound):
		return nil, errProjectNotFound()
	case errors.Is(err, store.ErrAgentMachineNotFound):
		return nil, connect.NewError(connect.CodeNotFound, errors.New("machine_not_found: machine not found"))
	case errors.Is(err, store.ErrAgentWorkspaceExists):
		return nil, connect.NewError(connect.CodeAlreadyExists, errors.New("workspace_exists: the folder of this machine is a workspace already"))
	case errors.Is(err, store.ErrTooManyAgentWorkspaces):
		return nil, connect.NewError(connect.CodeResourceExhausted, errors.New("too_many_workspaces: detach a workspace first"))
	case errors.Is(err, store.ErrNotFound):
		return nil, errUnauthenticated()
	case err != nil:
		return nil, internal(ctx, s.logger, req.Spec().Procedure, err)
	}
	s.changed(ctx, sess.UserID)
	return connect.NewResponse(&appv1.AttachAgentWorkspaceResponse{Workspace: agentWorkspaceProto(w)}), nil
}

func (s *agentProjectsService) DetachAgentWorkspace(ctx context.Context, req *connect.Request[appv1.DetachAgentWorkspaceRequest]) (*connect.Response[appv1.DetachAgentWorkspaceResponse], error) {
	sess, err := mustSession(ctx)
	if err != nil {
		return nil, err
	}
	err = s.store.DetachAgentWorkspace(ctx, s.tenantID, sess.UserID, req.Msg.GetWorkspaceId())
	switch {
	case errors.Is(err, store.ErrNotFound):
		return nil, errWorkspaceNotFound()
	case err != nil:
		return nil, internal(ctx, s.logger, req.Spec().Procedure, err)
	}
	s.changed(ctx, sess.UserID)
	return connect.NewResponse(&appv1.DetachAgentWorkspaceResponse{}), nil
}

func (s *agentProjectsService) MoveAgentWorkspace(ctx context.Context, req *connect.Request[appv1.MoveAgentWorkspaceRequest]) (*connect.Response[appv1.MoveAgentWorkspaceResponse], error) {
	sess, err := mustSession(ctx)
	if err != nil {
		return nil, err
	}
	w, err := s.store.MoveAgentWorkspace(ctx, s.tenantID, sess.UserID, req.Msg.GetWorkspaceId(), req.Msg.GetProjectId())
	switch {
	case errors.Is(err, store.ErrNotFound):
		return nil, errWorkspaceNotFound()
	case errors.Is(err, store.ErrAgentProjectNotFound):
		return nil, errProjectNotFound()
	case err != nil:
		return nil, internal(ctx, s.logger, req.Spec().Procedure, err)
	}
	s.changed(ctx, sess.UserID)
	return connect.NewResponse(&appv1.MoveAgentWorkspaceResponse{Workspace: agentWorkspaceProto(w)}), nil
}

// changed tells the user's sessions about a committed change. A failure
// does not fail the call (the change is made); the other devices then see
// it at their next list.
func (s *agentProjectsService) changed(ctx context.Context, userID int64) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), announceTimeout)
	defer cancel()
	if err := s.announce.AnnounceAgentProjectsChanged(ctx, userID); err != nil {
		s.logger.Warn("announcing an agent projects change failed", "user_id", userID, "err", err)
	}
}

func workspaceKindName(k appv1.AgentWorkspaceKind) (string, bool) {
	switch k {
	case appv1.AgentWorkspaceKind_AGENT_WORKSPACE_KIND_CLONE:
		return store.AgentWorkspaceClone, true
	case appv1.AgentWorkspaceKind_AGENT_WORKSPACE_KIND_WORKTREE:
		return store.AgentWorkspaceWorktree, true
	case appv1.AgentWorkspaceKind_AGENT_WORKSPACE_KIND_FOLDER:
		return store.AgentWorkspaceFolder, true
	default:
		return "", false
	}
}

func workspaceKindProto(kind string) appv1.AgentWorkspaceKind {
	switch kind {
	case store.AgentWorkspaceClone:
		return appv1.AgentWorkspaceKind_AGENT_WORKSPACE_KIND_CLONE
	case store.AgentWorkspaceWorktree:
		return appv1.AgentWorkspaceKind_AGENT_WORKSPACE_KIND_WORKTREE
	case store.AgentWorkspaceFolder:
		return appv1.AgentWorkspaceKind_AGENT_WORKSPACE_KIND_FOLDER
	default:
		return appv1.AgentWorkspaceKind_AGENT_WORKSPACE_KIND_UNSPECIFIED
	}
}

func agentProjectProto(p store.AgentProject) *appv1.AgentProject {
	out := &appv1.AgentProject{
		Id: p.ID, Name: p.Name, GitRemote: p.GitRemote, Order: p.Order, CreatedAt: p.CreatedAt.Unix(),
		Workspaces: make([]*appv1.AgentWorkspace, len(p.Workspaces)),
	}
	for i, w := range p.Workspaces {
		out.Workspaces[i] = agentWorkspaceProto(w)
	}
	return out
}

func agentWorkspaceProto(w store.AgentWorkspace) *appv1.AgentWorkspace {
	return &appv1.AgentWorkspace{
		Id: w.ID, ProjectId: w.ProjectID, MachineId: w.MachineID, Dir: w.Dir, Branch: w.Branch,
		Kind: workspaceKindProto(w.Kind), CreatedAt: w.CreatedAt.Unix(),
	}
}
