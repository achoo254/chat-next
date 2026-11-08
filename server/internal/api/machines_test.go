package api_test

import (
	"bytes"
	"context"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/auth/idptest"
	"connectrpc.com/connect"
)

// The machine directory end to end: the user's calls under /rpc with the
// session, chat-agent's under /machine-api with no Origin and no cookie.
func TestMachineDirectory(t *testing.T) {
	e := newEnv(t, withWebPush(t))
	ctx := context.Background()
	_, c := e.signedIn(t)
	machines := appv1connect.NewMachinesServiceClient(c, e.srv.URL+"/rpc", withOrigin(e.srv.URL))
	agent := appv1connect.NewMachineAgentServiceClient(e.srv.Client(), e.srv.URL+"/machine-api")

	// The user's calls need the session and the Origin of /rpc.
	anonymous := appv1connect.NewMachinesServiceClient(e.browser(t), e.srv.URL+"/rpc", withOrigin(e.srv.URL))
	if _, err := anonymous.CreateInstallCode(ctx, connect.NewRequest(&appv1.CreateInstallCodeRequest{})); codeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("without a session: %v", err)
	}
	noOrigin := appv1connect.NewMachinesServiceClient(c, e.srv.URL+"/rpc")
	if _, err := noOrigin.ListMachines(ctx, connect.NewRequest(&appv1.ListMachinesRequest{})); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("without Origin: %v", err)
	}

	code, err := machines.CreateInstallCode(ctx, connect.NewRequest(&appv1.CreateInstallCodeRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	reg, err := agent.RegisterMachine(ctx, connect.NewRequest(&appv1.RegisterMachineRequest{
		InstallCode: code.Msg.GetCode(), Name: "Mac mini", Os: "darwin", Arch: "arm64", AgentVersion: "0.1.0",
		PublicKey: bytes.Repeat([]byte{4}, 32),
	}))
	if err != nil {
		t.Fatal(err)
	}
	id, secret := reg.Msg.GetMachineId(), reg.Msg.GetMachineSecret()
	heartbeat := func() *appv1.HeartbeatResponse {
		t.Helper()
		req := connect.NewRequest(&appv1.HeartbeatRequest{TunnelUrl: "wss://dat.tunnel.hoandat.com", AgentVersion: "0.1.0", ClaudeVersion: "2.1.319"})
		req.Header().Set("Authorization", "Bearer "+secret)
		resp, err := agent.Heartbeat(ctx, req)
		if err != nil {
			t.Fatal(err)
		}
		return resp.Msg
	}
	heartbeat()
	notice := connect.NewRequest(&appv1.NotifyNeedsInputRequest{Kind: appv1.NeedsInputKind_NEEDS_INPUT_KIND_QUESTION, PendingCount: 1})
	notice.Header().Set("Authorization", "Bearer "+secret)
	if _, err := agent.NotifyNeedsInput(ctx, notice); err != nil {
		t.Fatal(err)
	}

	list, err := machines.ListMachines(ctx, connect.NewRequest(&appv1.ListMachinesRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Msg.GetMachines()) != 1 {
		t.Fatalf("machines %+v", list.Msg)
	}
	m := list.Msg.GetMachines()[0]
	if m.GetId() != id || m.GetName() != "Mac mini" || m.GetTunnelUrl() != "wss://dat.tunnel.hoandat.com" ||
		m.GetClaudeVersion() != "2.1.319" || len(m.GetPublicKey()) != 32 || m.GetLastSeenAt() == 0 {
		t.Fatalf("machine %+v", m)
	}
	renamed, err := machines.RenameMachine(ctx, connect.NewRequest(&appv1.RenameMachineRequest{MachineId: id, Name: "  Máy ở nhà "}))
	if err != nil || renamed.Msg.GetMachine().GetName() != "Máy ở nhà" {
		t.Fatalf("rename: %+v %v", renamed, err)
	}
	if _, err := machines.RenameMachine(ctx, connect.NewRequest(&appv1.RenameMachineRequest{MachineId: id, Name: " "})); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("empty name: %v", err)
	}
	if _, err := machines.RevokeDevice(ctx, connect.NewRequest(&appv1.RevokeDeviceRequest{MachineId: id, DevicePublicKey: []byte{1}})); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("short device key: %v", err)
	}
	phone := bytes.Repeat([]byte{8}, 32)
	if _, err := machines.RevokeDevice(ctx, connect.NewRequest(&appv1.RevokeDeviceRequest{MachineId: id, DevicePublicKey: phone})); err != nil {
		t.Fatal(err)
	}
	if got := heartbeat(); got.GetRevoked() || len(got.GetRevokedDeviceKeys()) != 1 || !bytes.Equal(got.GetRevokedDeviceKeys()[0], phone) {
		t.Fatalf("heartbeat after revoking a device: %+v", got)
	}

	// Another account sees nothing and changes nothing.
	e.idp.SetAccount(idptest.Account{Sub: "acc_bob", SID: "sid-bob", PreferredUsername: "bob", Name: "Bob"})
	_, bobClient := e.signedIn(t)
	bob := appv1connect.NewMachinesServiceClient(bobClient, e.srv.URL+"/rpc", withOrigin(e.srv.URL))
	if l, err := bob.ListMachines(ctx, connect.NewRequest(&appv1.ListMachinesRequest{})); err != nil || len(l.Msg.GetMachines()) != 0 {
		t.Fatalf("another account lists %+v %v", l, err)
	}
	if _, err := bob.RevokeMachine(ctx, connect.NewRequest(&appv1.RevokeMachineRequest{MachineId: id})); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("another account revokes: %v", err)
	}

	if _, err := machines.RevokeMachine(ctx, connect.NewRequest(&appv1.RevokeMachineRequest{MachineId: id})); err != nil {
		t.Fatal(err)
	}
	if got := heartbeat(); !got.GetRevoked() {
		t.Fatalf("heartbeat after revoking the machine: %+v", got)
	}
	if l, _ := machines.ListMachines(ctx, connect.NewRequest(&appv1.ListMachinesRequest{})); len(l.Msg.GetMachines()) != 0 {
		t.Fatalf("revoked machine still listed: %+v", l.Msg)
	}
}
