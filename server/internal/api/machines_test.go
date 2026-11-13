package api_test

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/api"
	"app.local/server/internal/auth/idptest"
	"app.local/server/internal/config"
	"app.local/server/internal/keyproof"
	"app.local/server/internal/machineapi"
	"connectrpc.com/connect"
)

// grantEndpoint is a fake of the IdP's tunelo-agent grant revocation.
type grantEndpoint struct {
	mu       sync.Mutex
	revoked  []map[string]string
	username string
	password string
}

func (g *grantEndpoint) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var body map[string]string
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid_request"}`, http.StatusBadRequest)
		return
	}
	user, pass, _ := r.BasicAuth()
	g.mu.Lock()
	g.revoked = append(g.revoked, body)
	g.username, g.password = user, pass
	g.mu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func (g *grantEndpoint) calls() ([]map[string]string, string, string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]map[string]string(nil), g.revoked...), g.username, g.password
}

func withGrantEndpoint(url string) func(*config.Config, *api.Options) {
	return func(c *config.Config, _ *api.Options) { c.TuneloGrantRevokeURL = url }
}

func newX25519(t *testing.T) *ecdh.PrivateKey {
	t.Helper()
	k, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func proveKey(t *testing.T, key *ecdh.PrivateKey, c *appv1.KeyChallenge) *appv1.KeyProof {
	t.Helper()
	server, err := ecdh.X25519().NewPublicKey(c.GetServerKey())
	if err != nil {
		t.Fatal(err)
	}
	shared, err := key.ECDH(server)
	if err != nil {
		t.Fatal(err)
	}
	return &appv1.KeyProof{Challenge: c, Mac: keyproof.MAC(shared, c.GetNonce())}
}

// registerDevice registers key for the session of machines, with a proof.
func registerDevice(t *testing.T, machines appv1connect.MachinesServiceClient, key *ecdh.PrivateKey, name string) (*appv1.AccountDevice, error) {
	t.Helper()
	ctx := context.Background()
	c, err := machines.GetDeviceKeyChallenge(ctx, connect.NewRequest(&appv1.GetDeviceKeyChallengeRequest{}))
	if err != nil {
		return nil, err
	}
	resp, err := machines.RegisterDevice(ctx, connect.NewRequest(&appv1.RegisterDeviceRequest{
		PublicKey: key.PublicKey().Bytes(), Name: name, Platform: "web", Proof: proveKey(t, key, c.Msg.GetChallenge()),
	}))
	if err != nil {
		return nil, err
	}
	return resp.Msg.GetDevice(), nil
}

// registerMachine registers key as tunelo does: a challenge, then the
// registration with its proof, both with token.
func registerMachine(t *testing.T, agent appv1connect.MachineAgentServiceClient, token string, key *ecdh.PrivateKey, name string) (int64, string) {
	t.Helper()
	ctx := context.Background()
	challenge := connect.NewRequest(&appv1.GetMachineKeyChallengeRequest{})
	challenge.Header().Set("Authorization", "Bearer "+token)
	ch, err := agent.GetMachineKeyChallenge(ctx, challenge)
	if err != nil {
		t.Fatal(err)
	}
	register := connect.NewRequest(&appv1.RegisterMachineRequest{
		Name: name, Os: "darwin", Arch: "arm64", AgentVersion: "3.0.0", PublicKey: key.PublicKey().Bytes(),
		Proof: proveKey(t, key, ch.Msg.GetChallenge()),
	})
	register.Header().Set("Authorization", "Bearer "+token)
	reg, err := agent.RegisterMachine(ctx, register)
	if err != nil {
		t.Fatal(err)
	}
	return reg.Msg.GetMachineId(), reg.Msg.GetMachineSecret()
}

// The account is the root of trust end to end: the user's calls under /rpc
// with the session, tunelo's under /machine-api with no Origin and no
// cookie. tunelo proves its key and registers with an access token of the
// account (aud the chat's /mcp, scope machines:write), then uses the machine
// secret; each browser proves and registers its own key, which the machine
// learns at its heartbeat until the key or its session is revoked.
func TestMachineDirectory(t *testing.T) {
	grants := &grantEndpoint{}
	idpGrants := httptest.NewServer(grants)
	t.Cleanup(idpGrants.Close)
	e := newEnv(t, withWebPush(t), withGrantEndpoint(idpGrants.URL+"/api/tunelo-agent/grants/revoke"))
	ctx := context.Background()
	_, c := e.signedIn(t)
	machines := appv1connect.NewMachinesServiceClient(c, e.srv.URL+"/rpc", withOrigin(e.srv.URL))
	agent := appv1connect.NewMachineAgentServiceClient(e.srv.Client(), e.srv.URL+"/machine-api")

	// The user's calls need the session and the Origin of /rpc.
	anonymous := appv1connect.NewMachinesServiceClient(e.browser(t), e.srv.URL+"/rpc", withOrigin(e.srv.URL))
	if _, err := anonymous.ListMachines(ctx, connect.NewRequest(&appv1.ListMachinesRequest{})); codeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("without a session: %v", err)
	}
	if _, err := anonymous.GetDeviceKeyChallenge(ctx, connect.NewRequest(&appv1.GetDeviceKeyChallengeRequest{})); codeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("device challenge without a session: %v", err)
	}
	noOrigin := appv1connect.NewMachinesServiceClient(c, e.srv.URL+"/rpc")
	if _, err := noOrigin.ListMachines(ctx, connect.NewRequest(&appv1.ListMachinesRequest{})); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("without Origin: %v", err)
	}

	// tunelo: challenge, then register with the proof.
	token := e.mcpToken(t, "chat:read machines:write", func(c map[string]any) string {
		c["client_id"], c["grant_id"] = "tunelo-agent", "grant-1"
		return ""
	})
	machineKey := newX25519(t)
	id, secret := registerMachine(t, agent, token, machineKey, "Mac mini")
	tunnel := "wss://" + machineapi.MachineSubdomain("acc_test", fmt.Sprintf("tunelo.%d", id)) + ".tunnel.hoandat.com"
	heartbeat := func() *appv1.HeartbeatResponse {
		t.Helper()
		req := connect.NewRequest(&appv1.HeartbeatRequest{TunnelUrl: tunnel, AgentVersion: "3.0.0"})
		req.Header().Set("Authorization", "Bearer "+secret)
		resp, err := agent.Heartbeat(ctx, req)
		if err != nil {
			t.Fatal(err)
		}
		return resp.Msg
	}
	if got := heartbeat(); len(got.GetTrustedDevices()) != 0 {
		t.Fatalf("trusted devices before any registered: %+v", got)
	}
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
	if m.GetId() != id || m.GetName() != "Mac mini" || m.GetTunnelUrl() != tunnel ||
		string(m.GetPublicKey()) != string(machineKey.PublicKey().Bytes()) || m.GetLastSeenAt() == 0 {
		t.Fatalf("machine %+v", m)
	}
	renamed, err := machines.RenameMachine(ctx, connect.NewRequest(&appv1.RenameMachineRequest{MachineId: id, Name: "  Máy ở nhà "}))
	if err != nil || renamed.Msg.GetMachine().GetName() != "Máy ở nhà" {
		t.Fatalf("rename: %+v %v", renamed, err)
	}
	if _, err := machines.RenameMachine(ctx, connect.NewRequest(&appv1.RenameMachineRequest{MachineId: id, Name: " "})); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("empty name: %v", err)
	}

	// Two browsers of the account register their keys; the machine learns both.
	laptopKey, phoneKey := newX25519(t), newX25519(t)
	laptop, err := registerDevice(t, machines, laptopKey, "Chrome on macOS")
	if err != nil || !laptop.GetCurrent() || laptop.GetRevokedAt() != 0 {
		t.Fatalf("register the laptop: %+v %v", laptop, err)
	}
	if _, err := machines.RegisterDevice(ctx, connect.NewRequest(&appv1.RegisterDeviceRequest{
		PublicKey: newX25519(t).PublicKey().Bytes(), Name: "x", Platform: "web", Proof: &appv1.KeyProof{},
	})); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("a device without a proof: %v", err)
	}
	_, phoneClient := e.signedIn(t)
	phoneMachines := appv1connect.NewMachinesServiceClient(phoneClient, e.srv.URL+"/rpc", withOrigin(e.srv.URL))
	if _, err := registerDevice(t, phoneMachines, phoneKey, "Safari on iPhone"); err != nil {
		t.Fatal(err)
	}
	if got := heartbeat().GetTrustedDevices(); len(got) != 2 || got[0].GetName() != "Chrome on macOS" || got[1].GetName() != "Safari on iPhone" {
		t.Fatalf("trusted devices %+v", got)
	}

	// Revoking the phone's key signs the phone out; the machine drops it and
	// the key never comes back.
	if _, err := machines.RevokeDevice(ctx, connect.NewRequest(&appv1.RevokeDeviceRequest{DevicePublicKey: []byte{1}})); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("short device key: %v", err)
	}
	if _, err := machines.RevokeDevice(ctx, connect.NewRequest(&appv1.RevokeDeviceRequest{DevicePublicKey: phoneKey.PublicKey().Bytes()})); err != nil {
		t.Fatal(err)
	}
	if _, err := phoneMachines.ListDevices(ctx, connect.NewRequest(&appv1.ListDevicesRequest{})); codeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("the revoked device's session still works: %v", err)
	}
	if got := heartbeat().GetTrustedDevices(); len(got) != 1 || got[0].GetName() != "Chrome on macOS" {
		t.Fatalf("trusted devices after revoking the phone %+v", got)
	}
	_, phoneAgain := e.signedIn(t)
	phoneMachines = appv1connect.NewMachinesServiceClient(phoneAgain, e.srv.URL+"/rpc", withOrigin(e.srv.URL))
	if _, err := registerDevice(t, phoneMachines, phoneKey, "Safari on iPhone"); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("the revoked key again: %v", err)
	}
	devices, err := machines.ListDevices(ctx, connect.NewRequest(&appv1.ListDevicesRequest{}))
	if err != nil || len(devices.Msg.GetDevices()) != 2 || !devices.Msg.GetDevices()[0].GetCurrent() ||
		devices.Msg.GetDevices()[1].GetRevokedAt() == 0 {
		t.Fatalf("devices %+v %v", devices, err)
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
	if _, err := bob.RevokeDevice(ctx, connect.NewRequest(&appv1.RevokeDeviceRequest{DevicePublicKey: laptopKey.PublicKey().Bytes()})); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("another account revokes a device: %v", err)
	}

	// Removing the machine stops it and revokes the grant of its sign-in at
	// the IdP, with the chat's client credentials.
	if _, err := machines.RevokeMachine(ctx, connect.NewRequest(&appv1.RevokeMachineRequest{MachineId: id})); err != nil {
		t.Fatal(err)
	}
	if got := heartbeat(); !got.GetRevoked() {
		t.Fatalf("heartbeat after revoking the machine: %+v", got)
	}
	if l, _ := machines.ListMachines(ctx, connect.NewRequest(&appv1.ListMachinesRequest{})); len(l.Msg.GetMachines()) != 0 {
		t.Fatalf("revoked machine still listed: %+v", l.Msg)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		calls, user, pass := grants.calls()
		if len(calls) == 1 {
			if calls[0]["sub"] != "acc_test" || calls[0]["grant_id"] != "grant-1" || user != clientID || pass != clientSecret {
				t.Fatalf("grant revocation %+v as %q", calls, user)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("grant revocation calls: %+v", calls)
		}
		time.Sleep(20 * time.Millisecond)
	}
	for {
		pending, err := e.store.PendingGrantRevocations(ctx, tenantID, 10)
		if err != nil {
			t.Fatal(err)
		}
		if len(pending) == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("grant still pending: %+v", pending)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
