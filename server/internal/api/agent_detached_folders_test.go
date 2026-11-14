package api_test

import (
	"context"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"connectrpc.com/connect"
)

// A folder the user dropped while its machine could not be told is marked
// on the server, listed with the projects for every device of the user, and
// unmarked again; bad folders and machines that are not the caller's are
// refused.
func TestAgentDetachedFolders(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	_, c := e.signedIn(t)
	base := e.srv.URL + "/rpc"
	projects := appv1connect.NewAgentProjectsServiceClient(c, base, withOrigin(e.srv.URL))

	anonymous := appv1connect.NewAgentProjectsServiceClient(e.browser(t), base, withOrigin(e.srv.URL))
	if _, err := anonymous.SetAgentFolderDetached(ctx, connect.NewRequest(&appv1.SetAgentFolderDetachedRequest{MachineId: 1, Dir: "/w/x", Detached: true})); codeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("without a session: %v", err)
	}

	agent := appv1connect.NewMachineAgentServiceClient(e.srv.Client(), e.srv.URL+"/machine-api")
	machine, _ := registerMachine(t, agent, e.mcpToken(t, "machines:write"), newX25519(t), "Mac")

	rpcOK(t, projects.SetAgentFolderDetached, &appv1.SetAgentFolderDetachedRequest{MachineId: machine, Dir: "/Users/dat/gone", Detached: true})
	listed := rpcOK(t, projects.ListAgentProjects, &appv1.ListAgentProjectsRequest{}).GetDetachedFolders()
	if len(listed) != 1 || listed[0].GetMachineId() != machine || listed[0].GetDir() != "/Users/dat/gone" {
		t.Fatalf("listed: %+v", listed)
	}

	for _, tc := range []struct {
		req  *appv1.SetAgentFolderDetachedRequest
		code connect.Code
	}{
		{&appv1.SetAgentFolderDetachedRequest{MachineId: machine, Dir: "relative/dir", Detached: true}, connect.CodeInvalidArgument},
		{&appv1.SetAgentFolderDetachedRequest{MachineId: machine, Dir: "", Detached: true}, connect.CodeInvalidArgument},
		{&appv1.SetAgentFolderDetachedRequest{MachineId: machine + 1000, Dir: "/w/x", Detached: true}, connect.CodeNotFound},
	} {
		if _, err := projects.SetAgentFolderDetached(ctx, connect.NewRequest(tc.req)); codeOf(err) != tc.code {
			t.Fatalf("set %+v: %v, want %v", tc.req, err, tc.code)
		}
	}

	rpcOK(t, projects.SetAgentFolderDetached, &appv1.SetAgentFolderDetachedRequest{MachineId: machine, Dir: "/Users/dat/gone", Detached: false})
	if listed := rpcOK(t, projects.ListAgentProjects, &appv1.ListAgentProjectsRequest{}).GetDetachedFolders(); len(listed) != 0 {
		t.Fatalf("after unmarking: %+v", listed)
	}
}
