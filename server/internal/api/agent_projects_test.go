package api_test

import (
	"context"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"connectrpc.com/connect"
)

// AI Agent projects end to end: the caller's own projects and workspaces
// under /rpc with the session; another account reads and changes nothing;
// every change reaches the user's log as agent_projects_changed.
func TestAgentProjects(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	_, c := e.signedIn(t)
	base := e.srv.URL + "/rpc"
	projects := appv1connect.NewAgentProjectsServiceClient(c, base, withOrigin(e.srv.URL))
	updates := appv1connect.NewUpdatesServiceClient(c, base, withOrigin(e.srv.URL))

	anonymous := appv1connect.NewAgentProjectsServiceClient(e.browser(t), base, withOrigin(e.srv.URL))
	if _, err := anonymous.ListAgentProjects(ctx, connect.NewRequest(&appv1.ListAgentProjectsRequest{})); codeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("without a session: %v", err)
	}
	if _, err := appv1connect.NewAgentProjectsServiceClient(c, base).ListAgentProjects(ctx, connect.NewRequest(&appv1.ListAgentProjectsRequest{})); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("without Origin: %v", err)
	}

	// A machine of the account (tunelo registers it with the account's token).
	agent := appv1connect.NewMachineAgentServiceClient(e.srv.Client(), e.srv.URL+"/machine-api")
	machine, _ := registerMachine(t, agent, e.mcpToken(t, "machines:write"), newX25519(t), "Mac")

	start := rpcOK(t, updates.GetState, &appv1.GetStateRequest{}).GetState()

	linked := rpcOK(t, projects.CreateAgentProject, &appv1.CreateAgentProjectRequest{
		Name: " chat-next ", GitRemote: "https://user:secret@GitHub.com/achoo254/chat-next.git/",
	}).GetProject()
	if linked.GetName() != "chat-next" || linked.GetGitRemote() != "github.com/achoo254/chat-next" || linked.GetId() == 0 {
		t.Fatalf("linked project %+v", linked)
	}
	empty := rpcOK(t, projects.CreateAgentProject, &appv1.CreateAgentProjectRequest{Name: "Notes"}).GetProject()
	if empty.GetGitRemote() != "" || empty.GetOrder() <= linked.GetOrder() {
		t.Fatalf("empty project %+v", empty)
	}
	for _, tc := range []struct {
		req  *appv1.CreateAgentProjectRequest
		code connect.Code
	}{
		{&appv1.CreateAgentProjectRequest{Name: "again", GitRemote: "git@github.com:achoo254/chat-next.git"}, connect.CodeAlreadyExists},
		{&appv1.CreateAgentProjectRequest{Name: "local", GitRemote: "/srv/git/app.git"}, connect.CodeInvalidArgument},
		{&appv1.CreateAgentProjectRequest{Name: " "}, connect.CodeInvalidArgument},
	} {
		if _, err := projects.CreateAgentProject(ctx, connect.NewRequest(tc.req)); codeOf(err) != tc.code {
			t.Fatalf("create %+v: %v, want %v", tc.req, err, tc.code)
		}
	}

	ws := rpcOK(t, projects.AttachAgentWorkspace, &appv1.AttachAgentWorkspaceRequest{
		ProjectId: linked.GetId(), MachineId: machine, Dir: "/Users/dat/chat-next", Branch: "main",
		Kind: appv1.AgentWorkspaceKind_AGENT_WORKSPACE_KIND_CLONE,
	}).GetWorkspace()
	if ws.GetMachineId() != machine || ws.GetProjectId() != linked.GetId() || ws.GetKind() != appv1.AgentWorkspaceKind_AGENT_WORKSPACE_KIND_CLONE {
		t.Fatalf("workspace %+v", ws)
	}
	for _, tc := range []struct {
		req  *appv1.AttachAgentWorkspaceRequest
		code connect.Code
	}{
		{&appv1.AttachAgentWorkspaceRequest{ProjectId: empty.GetId(), MachineId: machine, Dir: "/Users/dat/chat-next", Kind: appv1.AgentWorkspaceKind_AGENT_WORKSPACE_KIND_FOLDER}, connect.CodeAlreadyExists},
		{&appv1.AttachAgentWorkspaceRequest{ProjectId: empty.GetId(), MachineId: machine, Dir: "relative", Kind: appv1.AgentWorkspaceKind_AGENT_WORKSPACE_KIND_FOLDER}, connect.CodeInvalidArgument},
		{&appv1.AttachAgentWorkspaceRequest{ProjectId: empty.GetId(), MachineId: machine, Dir: "/x"}, connect.CodeInvalidArgument},
		{&appv1.AttachAgentWorkspaceRequest{ProjectId: empty.GetId(), MachineId: machine + 1000, Dir: "/x", Kind: appv1.AgentWorkspaceKind_AGENT_WORKSPACE_KIND_FOLDER}, connect.CodeNotFound},
	} {
		if _, err := projects.AttachAgentWorkspace(ctx, connect.NewRequest(tc.req)); codeOf(err) != tc.code {
			t.Fatalf("attach %+v: %v, want %v", tc.req, err, tc.code)
		}
	}

	// Every change is in the user's log for the other devices.
	diff := rpcOK(t, updates.GetDifference, &appv1.GetDifferenceRequest{Pts: start.GetPts(), ServerEpoch: start.GetServerEpoch()}).GetFull()
	changes := 0
	for _, u := range diff.GetUpdates() {
		if u.GetAgentProjectsChanged() != nil {
			changes++
		}
	}
	if changes != 3 {
		t.Fatalf("%d agent_projects_changed updates after 3 changes: %+v", changes, diff)
	}

	// Another account sees nothing and changes nothing.
	bob := e.member(t, "bob")
	bobProjects := appv1connect.NewAgentProjectsServiceClient(bob.http, base, withOrigin(e.srv.URL))
	if l := rpcOK(t, bobProjects.ListAgentProjects, &appv1.ListAgentProjectsRequest{}); len(l.GetProjects()) != 0 {
		t.Fatalf("bob lists %+v", l)
	}
	bobOwn := rpcOK(t, bobProjects.CreateAgentProject, &appv1.CreateAgentProjectRequest{Name: "mine", GitRemote: "github.com:achoo254/chat-next"}).GetProject()
	for name, call := range map[string]func() error{
		"rename": func() error {
			_, err := bobProjects.RenameAgentProject(ctx, connect.NewRequest(&appv1.RenameAgentProjectRequest{ProjectId: linked.GetId(), Name: "x"}))
			return err
		},
		"delete": func() error {
			_, err := bobProjects.DeleteAgentProject(ctx, connect.NewRequest(&appv1.DeleteAgentProjectRequest{ProjectId: linked.GetId()}))
			return err
		},
		"reorder": func() error {
			_, err := bobProjects.ReorderAgentProjects(ctx, connect.NewRequest(&appv1.ReorderAgentProjectsRequest{ProjectIds: []int64{bobOwn.GetId(), linked.GetId()}}))
			return err
		},
		"detach": func() error {
			_, err := bobProjects.DetachAgentWorkspace(ctx, connect.NewRequest(&appv1.DetachAgentWorkspaceRequest{WorkspaceId: ws.GetId()}))
			return err
		},
		"move mine into bob's": func() error {
			_, err := bobProjects.MoveAgentWorkspace(ctx, connect.NewRequest(&appv1.MoveAgentWorkspaceRequest{WorkspaceId: ws.GetId(), ProjectId: bobOwn.GetId()}))
			return err
		},
		"attach on my machine": func() error {
			_, err := bobProjects.AttachAgentWorkspace(ctx, connect.NewRequest(&appv1.AttachAgentWorkspaceRequest{
				ProjectId: bobOwn.GetId(), MachineId: machine, Dir: "/x", Kind: appv1.AgentWorkspaceKind_AGENT_WORKSPACE_KIND_FOLDER,
			}))
			return err
		},
		"attach to my project": func() error {
			_, err := bobProjects.AttachAgentWorkspace(ctx, connect.NewRequest(&appv1.AttachAgentWorkspaceRequest{
				ProjectId: linked.GetId(), MachineId: machine, Dir: "/x", Kind: appv1.AgentWorkspaceKind_AGENT_WORKSPACE_KIND_FOLDER,
			}))
			return err
		},
	} {
		if err := call(); codeOf(err) != connect.CodeNotFound {
			t.Fatalf("bob %s: %v", name, err)
		}
	}
	if _, err := projects.MoveAgentWorkspace(ctx, connect.NewRequest(&appv1.MoveAgentWorkspaceRequest{WorkspaceId: ws.GetId(), ProjectId: bobOwn.GetId()})); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("move into bob's project: %v", err)
	}

	renamed := rpcOK(t, projects.RenameAgentProject, &appv1.RenameAgentProjectRequest{ProjectId: linked.GetId(), Name: "Chat"}).GetProject()
	if renamed.GetName() != "Chat" || len(renamed.GetWorkspaces()) != 1 {
		t.Fatalf("renamed %+v", renamed)
	}
	// The git link set or changed later: kept as its key, a duplicate refused, unlinked with "", bob changes nothing.
	str := func(v string) *string { return &v }
	before := rpcOK(t, updates.GetState, &appv1.GetStateRequest{}).GetState()
	linkedLater := rpcOK(t, projects.UpdateAgentProject, &appv1.UpdateAgentProjectRequest{ProjectId: empty.GetId(), GitRemote: str("git@GitHub.com:achoo254/Notes.git")}).GetProject()
	if linkedLater.GetGitRemote() != "github.com/achoo254/notes" || linkedLater.GetName() != "Notes" {
		t.Fatalf("linked later %+v", linkedLater)
	}
	for _, tc := range []struct {
		req  *appv1.UpdateAgentProjectRequest
		code connect.Code
	}{
		{&appv1.UpdateAgentProjectRequest{ProjectId: empty.GetId(), GitRemote: str("https://github.com/achoo254/chat-next")}, connect.CodeAlreadyExists},
		{&appv1.UpdateAgentProjectRequest{ProjectId: empty.GetId(), GitRemote: str("/srv/git/app.git")}, connect.CodeInvalidArgument},
		{&appv1.UpdateAgentProjectRequest{ProjectId: empty.GetId(), Name: str(" ")}, connect.CodeInvalidArgument},
		{&appv1.UpdateAgentProjectRequest{ProjectId: empty.GetId()}, connect.CodeInvalidArgument},
		{&appv1.UpdateAgentProjectRequest{ProjectId: empty.GetId() + 1000, Name: str("x")}, connect.CodeNotFound},
	} {
		if _, err := projects.UpdateAgentProject(ctx, connect.NewRequest(tc.req)); codeOf(err) != tc.code {
			t.Fatalf("update %+v: %v, want %v", tc.req, err, tc.code)
		}
	}
	if _, err := bobProjects.UpdateAgentProject(ctx, connect.NewRequest(&appv1.UpdateAgentProjectRequest{ProjectId: empty.GetId(), GitRemote: str("")})); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("bob unlinks mine: %v", err)
	}
	unlinked := rpcOK(t, projects.UpdateAgentProject, &appv1.UpdateAgentProjectRequest{ProjectId: empty.GetId(), GitRemote: str("")}).GetProject()
	if unlinked.GetGitRemote() != "" {
		t.Fatalf("unlinked %+v", unlinked)
	}
	diff = rpcOK(t, updates.GetDifference, &appv1.GetDifferenceRequest{Pts: before.GetPts(), ServerEpoch: before.GetServerEpoch()}).GetFull()
	changes = 0
	for _, u := range diff.GetUpdates() {
		if u.GetAgentProjectsChanged() != nil {
			changes++
		}
	}
	if changes != 2 {
		t.Fatalf("%d agent_projects_changed updates after linking and unlinking", changes)
	}
	// Reordered by hand: the order every list gives from now on, announced; an empty list is refused.
	if _, err := projects.ReorderAgentProjects(ctx, connect.NewRequest(&appv1.ReorderAgentProjectsRequest{})); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("empty reorder: %v", err)
	}
	beforeReorder := rpcOK(t, updates.GetState, &appv1.GetStateRequest{}).GetState()
	rpcOK(t, projects.ReorderAgentProjects, &appv1.ReorderAgentProjectsRequest{ProjectIds: []int64{empty.GetId(), linked.GetId()}})
	if l := rpcOK(t, projects.ListAgentProjects, &appv1.ListAgentProjectsRequest{}).GetProjects(); len(l) < 2 || l[0].GetId() != empty.GetId() || l[1].GetId() != linked.GetId() {
		t.Fatalf("after reorder %+v", l)
	}
	diff = rpcOK(t, updates.GetDifference, &appv1.GetDifferenceRequest{Pts: beforeReorder.GetPts(), ServerEpoch: beforeReorder.GetServerEpoch()}).GetFull()
	if len(diff.GetUpdates()) != 1 || diff.GetUpdates()[0].GetAgentProjectsChanged() == nil {
		t.Fatalf("updates after reorder: %+v", diff.GetUpdates())
	}
	moved := rpcOK(t, projects.MoveAgentWorkspace, &appv1.MoveAgentWorkspaceRequest{WorkspaceId: ws.GetId(), ProjectId: empty.GetId()}).GetWorkspace()
	if moved.GetProjectId() != empty.GetId() {
		t.Fatalf("moved %+v", moved)
	}
	// Deleting a project drops its workspace records with it.
	rpcOK(t, projects.DeleteAgentProject, &appv1.DeleteAgentProjectRequest{ProjectId: empty.GetId()})
	list := rpcOK(t, projects.ListAgentProjects, &appv1.ListAgentProjectsRequest{}).GetProjects()
	if len(list) != 1 || list[0].GetId() != linked.GetId() || len(list[0].GetWorkspaces()) != 0 {
		t.Fatalf("after delete %+v", list)
	}
	if _, err := projects.DetachAgentWorkspace(ctx, connect.NewRequest(&appv1.DetachAgentWorkspaceRequest{WorkspaceId: ws.GetId()})); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("detach a deleted workspace: %v", err)
	}
	if l := rpcOK(t, bobProjects.ListAgentProjects, &appv1.ListAgentProjectsRequest{}).GetProjects(); len(l) != 1 || l[0].GetId() != bobOwn.GetId() {
		t.Fatalf("bob's projects changed: %+v", l)
	}
}
