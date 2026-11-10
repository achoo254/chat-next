package machineapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/auth"
	"app.local/server/internal/auth/idptest"
	"app.local/server/internal/push"
	"app.local/server/internal/ratelimit"
	"app.local/server/internal/store"
	"app.local/server/internal/store/testdb"
	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
)

const (
	tenant   = "primary"
	resource = "https://chat.hoandat.com/mcp"
	ownerSub = "acc_1"
)

func TestMain(m *testing.M) {
	os.Exit(testdb.Main(m))
}

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

// notifier records the notices it is asked to push.
type notifier struct {
	mu   sync.Mutex
	sent []push.MachineNotice
	user []int64
}

func (n *notifier) NotifyUser(_ context.Context, userID int64, notice push.MachineNotice) (int, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.sent = append(n.sent, notice)
	n.user = append(n.user, userID)
	return 1, nil
}

func (n *notifier) take() []push.MachineNotice {
	n.mu.Lock()
	defer n.mu.Unlock()
	out := n.sent
	n.sent = nil
	return out
}

func (n *notifier) users() []int64 {
	n.mu.Lock()
	defer n.mu.Unlock()
	return append([]int64(nil), n.user...)
}

// timer is a pending merged push that the test fires by hand.
type timer struct {
	after   time.Duration
	fire    func()
	stopped bool
}

func (t *timer) Stop() bool { t.stopped = true; return true }

type env struct {
	t        *testing.T
	store    *store.Store
	svc      *Service
	client   appv1connect.MachineAgentServiceClient
	notifier *notifier
	idp      *idptest.Provider
	userID   int64

	// The service's clock and timers, used from the handler's goroutines.
	mu     sync.Mutex
	clock  time.Time
	timers []*timer
}

func (e *env) now() time.Time {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.clock
}

func (e *env) advance(d time.Duration) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.clock = e.clock.Add(d)
}

func (e *env) pending() []*timer {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]*timer(nil), e.timers...)
}

// wrong returns secret with its last character changed.
func wrong(secret string) string {
	last := byte('A')
	if secret[len(secret)-1] == last {
		last = 'B'
	}
	return secret[:len(secret)-1] + string(last)
}

func newEnv(t *testing.T) *env {
	t.Helper()
	ctx := context.Background()
	st := testdb.Open(t)
	if err := st.EnsureTenant(ctx, tenant, "hoandat.com", "hoandat.com"); err != nil {
		t.Fatal(err)
	}
	u, err := st.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: ownerSub, PreferredUsername: "dat"})
	if err != nil {
		t.Fatal(err)
	}
	provider := idptest.New(t, "chat-web", "secret")
	verifier := auth.NewIdP(auth.IdPConfig{
		Issuer: provider.Issuer(), ClientID: "chat-web", ClientSecret: "secret", RedirectURL: "https://chat.hoandat.com/auth/callback",
		HTTPClient: provider.Server.Client(), Logger: quiet,
	})
	if err := verifier.Discover(ctx); err != nil {
		t.Fatal(err)
	}
	e := &env{t: t, store: st, notifier: &notifier{}, idp: provider, userID: u.ID, clock: time.Unix(1_800_000_000, 0)}
	e.svc, err = New(Config{TenantID: tenant, TenantDomain: "hoandat.com", Resource: resource}, st, verifier, e.notifier, ratelimit.NewMemory(), quiet)
	if err != nil {
		t.Fatal(err)
	}
	e.svc.now = e.now
	e.svc.after = func(d time.Duration, f func()) stopper {
		tm := &timer{after: d, fire: f}
		e.mu.Lock()
		e.timers = append(e.timers, tm)
		e.mu.Unlock()
		return tm
	}
	t.Cleanup(e.svc.Close)
	mux := http.NewServeMux()
	mux.Handle(Prefix, e.svc.Handler())
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	// A plain client, as tunelo: no Origin, no cookie.
	e.client = appv1connect.NewMachineAgentServiceClient(srv.Client(), srv.URL+"/machine-api")
	return e
}

// token signs an access token of tunelo-agent for sub; mods change the
// claims (or return a typ to sign with) to build bad tokens.
func (e *env) token(sub string, mods ...func(claims map[string]any) string) string {
	e.t.Helper()
	claims := map[string]any{
		"iss": e.idp.Issuer(), "aud": resource, "sub": sub, "client_id": "tunelo-agent",
		"scope": "chat:read chat:write machines:write", "iat": time.Now().Unix(), "exp": time.Now().Add(10 * time.Minute).Unix(),
	}
	typ := "at+jwt"
	for _, mod := range mods {
		if v := mod(claims); v != "" {
			typ = v
		}
	}
	tok, err := e.idp.Sign(claims, typ)
	if err != nil {
		e.t.Fatal(err)
	}
	return tok
}

func registerRequest() *appv1.RegisterMachineRequest {
	return &appv1.RegisterMachineRequest{Name: " Mac mini ", Os: "darwin", Arch: "arm64",
		AgentVersion: "2.1.0", PublicKey: bytes.Repeat([]byte{5}, 32)}
}

func (e *env) register() (int64, string) {
	e.t.Helper()
	resp, err := e.client.RegisterMachine(context.Background(), withSecret(registerRequest(), e.token(ownerSub)))
	if err != nil {
		e.t.Fatal(err)
	}
	return resp.Msg.GetMachineId(), resp.Msg.GetMachineSecret()
}

// legacy inserts a machine of the owner as an install code made it
// (unclaimed) and returns its id and secret.
func (e *env) legacy() (int64, string) {
	e.t.Helper()
	secret := strings.Repeat("L", 43)
	hash := sha256.Sum256([]byte(secret))
	var id int64
	if err := e.store.Pool().QueryRow(context.Background(), `
		INSERT INTO machines (tenant_id, user_id, name, os, arch, agent_version, public_key, secret_hash)
		VALUES ($1, $2, 'Laptop', 'win32', 'x64', '0.2.4', $3, $4) RETURNING id`,
		tenant, e.userID, bytes.Repeat([]byte{6}, 32), hash[:]).Scan(&id); err != nil {
		e.t.Fatal(err)
	}
	return id, secret
}

// machineTunnel is the tunnel Tunelo holds for the machine id of sub.
func machineTunnel(sub string, id int64) string {
	return "wss://" + MachineSubdomain(sub, "tunelo."+strconv.FormatInt(id, 10)) + ".tunnel.hoandat.com"
}

func withSecret[T any](msg *T, secret string) *connect.Request[T] {
	req := connect.NewRequest(msg)
	req.Header().Set("Authorization", "Bearer "+secret)
	return req
}

func TestRegisterMachine(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	for name, tok := range map[string]string{
		"none":    "",
		"garbage": "not-a-jwt",
		"aud":     e.token(ownerSub, func(c map[string]any) string { c["aud"] = "https://localman.hoandat.com/mcp"; return "" }),
		"typ":     e.token(ownerSub, func(map[string]any) string { return "JWT" }),
		"expired": e.token(ownerSub, func(c map[string]any) string { c["exp"] = time.Now().Add(-time.Minute).Unix(); return "" }),
		"issuer":  e.token(ownerSub, func(c map[string]any) string { c["iss"] = "https://auth.evil.test"; return "" }),
		"secret":  strings.Repeat("A", 43),
		"no sub":  e.token(""),
	} {
		req := connect.NewRequest(registerRequest())
		if tok != "" {
			req.Header().Set("Authorization", "Bearer "+tok)
		}
		// An install code alone no longer registers anything.
		req.Msg.InstallCode = strings.Repeat("c", 22) //nolint:staticcheck // the deprecated field must be ignored
		if _, err := e.client.RegisterMachine(ctx, req); connect.CodeOf(err) != connect.CodeUnauthenticated {
			t.Errorf("%s: %v", name, err)
		}
	}
	noScope := e.token(ownerSub, func(c map[string]any) string { c["scope"] = "chat:read chat:write"; return "" })
	if _, err := e.client.RegisterMachine(ctx, withSecret(registerRequest(), noScope)); connect.CodeOf(err) != connect.CodePermissionDenied ||
		!strings.Contains(err.Error(), "insufficient_scope") {
		t.Fatalf("without machines:write: %v", err)
	}
	// Signed with a key outside the IdP's JWKS, with the IdP's issuer.
	stranger := idptest.New(t, "chat-web", "secret")
	forged, err := stranger.Sign(map[string]any{
		"iss": e.idp.Issuer(), "aud": resource, "sub": ownerSub, "client_id": "tunelo-agent", "scope": "machines:write",
		"iat": time.Now().Unix(), "exp": time.Now().Add(10 * time.Minute).Unix(),
	}, "at+jwt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.client.RegisterMachine(ctx, withSecret(registerRequest(), forged)); connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("token of a foreign key: %v", err)
	}

	tok := e.token(ownerSub)
	for name, msg := range map[string]*appv1.RegisterMachineRequest{
		"no name":     {Os: "darwin", Arch: "arm64", AgentVersion: "2.1.0", PublicKey: make([]byte, 32)},
		"bad os":      {Name: "m", Os: "freebsd", Arch: "arm64", AgentVersion: "2.1.0", PublicKey: make([]byte, 32)},
		"bad arch":    {Name: "m", Os: "darwin", Arch: "ia32", AgentVersion: "2.1.0", PublicKey: make([]byte, 32)},
		"bad version": {Name: "m", Os: "darwin", Arch: "arm64", AgentVersion: "v1", PublicKey: make([]byte, 32)},
		"short key":   {Name: "m", Os: "darwin", Arch: "arm64", AgentVersion: "2.1.0", PublicKey: make([]byte, 31)},
	} {
		if _, err := e.client.RegisterMachine(ctx, withSecret(msg, tok)); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Errorf("%s: %v", name, err)
		}
	}
	old := registerRequest()
	old.AgentVersion = "2.0.15"
	if _, err := e.client.RegisterMachine(ctx, withSecret(old, tok)); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("old agent: %v", err)
	}
	resp, err := e.client.RegisterMachine(ctx, withSecret(registerRequest(), tok))
	if err != nil {
		t.Fatal(err)
	}
	if resp.Msg.GetMachineId() <= 0 || len(resp.Msg.GetMachineSecret()) != 43 {
		t.Fatalf("answer %+v", resp.Msg)
	}
	list, err := e.store.ListMachines(ctx, tenant, e.userID)
	if err != nil || len(list) != 1 || list[0].Name != "Mac mini" || !list[0].Claimed {
		t.Fatalf("directory %+v %v", list, err)
	}
}

func TestRegisterMachineCreatesTheChatUser(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	// New accounts refused (sign-up caps): a reason of its own, so tunelo waits.
	var asked []string
	e.svc.cfg.AdmitNewUser = func(ip string) bool { asked = append(asked, ip); return false }
	_, err := e.client.RegisterMachine(ctx, withSecret(registerRequest(), e.token("acc_new")))
	if connect.CodeOf(err) != connect.CodeFailedPrecondition || !strings.Contains(err.Error(), "chat_account_missing") {
		t.Fatalf("new account refused: %v", err)
	}
	if len(asked) != 1 || asked[0] == "" {
		t.Fatalf("admission asked %v", asked)
	}
	if _, err := e.store.UserByIdPSub(ctx, tenant, "acc_new"); err != nil && !errors.Is(err, store.ErrNotFound) {
		t.Fatal(err)
	} else if err == nil {
		t.Fatal("a refused account got a user")
	}
	// Admitted: the user is created, pending its profile, and owns the machine.
	e.svc.cfg.AdmitNewUser = func(string) bool { return true }
	resp, err := e.client.RegisterMachine(ctx, withSecret(registerRequest(), e.token("acc_new")))
	if err != nil {
		t.Fatal(err)
	}
	u, err := e.store.UserByIdPSub(ctx, tenant, "acc_new")
	if err != nil || !u.ProfilePending || u.Username != "acc_new" {
		t.Fatalf("created user %+v %v", u, err)
	}
	list, err := e.store.ListMachines(ctx, tenant, u.ID)
	if err != nil || len(list) != 1 || list[0].ID != resp.Msg.GetMachineId() || !list[0].Claimed {
		t.Fatalf("machines of the new user %+v %v", list, err)
	}
	// An existing user is never admitted again.
	e.svc.cfg.AdmitNewUser = func(string) bool { t.Error("admission asked for an existing user"); return false }
	if _, err := e.client.RegisterMachine(ctx, withSecret(registerRequest(), e.token(ownerSub))); err != nil {
		t.Fatal(err)
	}
}

func TestRegisterMachineLimitHoldsUnderConcurrency(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	for i := range 19 {
		if _, err := e.store.Pool().Exec(ctx, `
			INSERT INTO machines (tenant_id, user_id, name, os, arch, agent_version, public_key, secret_hash)
			VALUES ($1, $2, 'm', 'linux', 'x64', '0.1.0', $3, $4)`,
			tenant, e.userID, bytes.Repeat([]byte{1}, 32), bytes.Repeat([]byte{byte(i + 1)}, 32)); err != nil {
			t.Fatal(err)
		}
	}
	tok := e.token(ownerSub)
	errs := make([]error, 2)
	var wg sync.WaitGroup
	for i := range errs {
		wg.Go(func() {
			_, errs[i] = e.client.RegisterMachine(ctx, withSecret(registerRequest(), tok))
		})
	}
	wg.Wait()
	ok, full := 0, 0
	for _, err := range errs {
		switch {
		case err == nil:
			ok++
		case connect.CodeOf(err) == connect.CodeResourceExhausted:
			full++
		default:
			t.Fatalf("parallel register: %v", err)
		}
	}
	if ok != 1 || full != 1 {
		t.Fatalf("the 20th machine: %d registered, %d refused", ok, full)
	}
}

func TestRegisterMachineLimit(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	e.register()
	for i := range 19 {
		if _, err := e.store.Pool().Exec(ctx, `
			INSERT INTO machines (tenant_id, user_id, name, os, arch, agent_version, public_key, secret_hash)
			VALUES ($1, $2, 'm', 'linux', 'x64', '0.1.0', $3, $4)`,
			tenant, e.userID, bytes.Repeat([]byte{1}, 32), bytes.Repeat([]byte{byte(i + 1)}, 32)); err != nil {
			t.Fatal(err)
		}
	}
	_, err := e.client.RegisterMachine(ctx, withSecret(registerRequest(), e.token(ownerSub)))
	if connect.CodeOf(err) != connect.CodeResourceExhausted || !strings.Contains(err.Error(), "too_many_machines") {
		t.Fatalf("the 21st machine: %v", err)
	}
}

func TestClaimMachine(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	if _, err := e.store.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_2", PreferredUsername: "binh"}); err != nil {
		t.Fatal(err)
	}
	id, secret := e.legacy()
	claim := func(tok, secret string) error {
		_, err := e.client.ClaimMachine(ctx, withSecret(&appv1.ClaimMachineRequest{MachineSecret: secret}, tok))
		return err
	}
	beat := func(tunnel string) (*appv1.HeartbeatResponse, error) {
		resp, err := e.client.Heartbeat(ctx, withSecret(&appv1.HeartbeatRequest{TunnelUrl: tunnel, AgentVersion: "2.1.0"}, secret))
		if err != nil {
			return nil, err
		}
		return resp.Msg, nil
	}
	// Unclaimed: any tunnel of the domain passes, and the agent is told to claim.
	if r, err := beat("wss://old-name.tunnel.hoandat.com"); err != nil || r.GetClaimed() {
		t.Fatalf("unclaimed heartbeat: %+v %v", r, err)
	}

	if err := claim("", secret); connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("without a token: %v", err)
	}
	noScope := e.token(ownerSub, func(c map[string]any) string { c["scope"] = "chat:read"; return "" })
	if err := claim(noScope, secret); connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("without machines:write: %v", err)
	}
	if err := claim(e.token(ownerSub), strings.Repeat("W", 43)); connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("wrong secret: %v", err)
	}
	if err := claim(e.token(ownerSub), "short"); connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("malformed secret: %v", err)
	}
	if err := claim(e.token("acc_2"), secret); connect.CodeOf(err) != connect.CodePermissionDenied || !strings.Contains(err.Error(), "claim_wrong_account") {
		t.Fatalf("claim by another account: %v", err)
	}
	if list, _ := e.store.ListMachines(ctx, tenant, e.userID); list[0].Claimed {
		t.Fatal("claimed by the wrong account")
	}
	if err := claim(e.token(ownerSub), secret); err != nil {
		t.Fatal(err)
	}
	if err := claim(e.token(ownerSub), secret); err != nil {
		t.Fatalf("claim again: %v", err)
	}

	// Claimed: only the machine tunnel of the owner's account is listed. Another
	// one is refused without failing the heartbeat: the machine stays alive
	// without a tunnel and still learns which devices were revoked.
	phone := bytes.Repeat([]byte{9}, 32)
	if err := e.store.RevokeMachineDevice(ctx, tenant, e.userID, id, phone); err != nil {
		t.Fatal(err)
	}
	for _, tunnel := range []string{"wss://old-name.tunnel.hoandat.com", machineTunnel("acc_2", id), machineTunnel(ownerSub, id+1)} {
		r, err := beat(tunnel)
		if err != nil || !r.GetTunnelRefused() || len(r.GetRevokedDeviceKeys()) != 1 || !bytes.Equal(r.GetRevokedDeviceKeys()[0], phone) {
			t.Errorf("tunnel %s: %+v %v", tunnel, r, err)
		}
		if list, _ := e.store.ListMachines(ctx, tenant, e.userID); list[0].TunnelURL != "" {
			t.Fatalf("a refused tunnel was listed: %q", list[0].TunnelURL)
		}
	}
	if r, err := beat(machineTunnel(ownerSub, id) + "/"); err != nil || !r.GetClaimed() || r.GetTunnelRefused() {
		t.Fatalf("own tunnel: %+v %v", r, err)
	}
	if list, _ := e.store.ListMachines(ctx, tenant, e.userID); list[0].TunnelURL != machineTunnel(ownerSub, id) {
		t.Fatalf("own tunnel recorded %q", list[0].TunnelURL)
	}
	if r, err := beat(""); err != nil || !r.GetClaimed() {
		t.Fatalf("tunnel down: %+v %v", r, err)
	}

	if err := e.store.RevokeMachine(ctx, tenant, e.userID, id); err != nil {
		t.Fatal(err)
	}
	if err := claim(e.token(ownerSub), secret); connect.CodeOf(err) != connect.CodePermissionDenied || !strings.Contains(err.Error(), "machine_revoked") {
		t.Fatalf("claim a revoked machine: %v", err)
	}
}

func TestRegisteredMachineTunnelIsChecked(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	id, secret := e.register()
	beat := func(tunnel string) (bool, error) {
		r, err := e.client.Heartbeat(ctx, withSecret(&appv1.HeartbeatRequest{TunnelUrl: tunnel, AgentVersion: "2.1.0"}, secret))
		if err != nil {
			return false, err
		}
		return r.Msg.GetTunnelRefused(), nil
	}
	if refused, err := beat("wss://dat-mac.tunnel.hoandat.com"); err != nil || !refused {
		t.Fatalf("another tunnel: %v %v", refused, err)
	}
	if refused, err := beat(machineTunnel(ownerSub, id)); err != nil || refused {
		t.Fatalf("own tunnel: %v %v", refused, err)
	}
}

// Pairing stays end to end: the agent's calls carry no device key, install
// secret or authenticator (TOTP) secret, so the server can never vouch for a
// device or compute a pairing code. Any new field fails here first.
func TestAgentCallsTakeNoDeviceKey(t *testing.T) {
	for msg, want := range map[proto.Message][]string{
		&appv1.RegisterMachineRequest{}:  {"install_code", "name", "os", "arch", "agent_version", "public_key"},
		&appv1.HeartbeatRequest{}:        {"tunnel_url", "agent_version", "claude_version"},
		&appv1.ClaimMachineRequest{}:     {"machine_secret"},
		&appv1.NotifyNeedsInputRequest{}: {"kind", "pending_count", "session_id"},
	} {
		fields := msg.ProtoReflect().Descriptor().Fields()
		var got []string
		for i := range fields.Len() {
			got = append(got, string(fields.Get(i).Name()))
		}
		if !slices.Equal(got, want) {
			t.Errorf("%s fields %v, want %v", msg.ProtoReflect().Descriptor().Name(), got, want)
		}
	}
}

func TestMachineSubdomain(t *testing.T) {
	// Vectors from tunelo-server's machineSubdomain (machine-subdomain.ts).
	for _, v := range []struct{ sub, device, want string }{
		{"acc_1", "tunelo.1", "m-c0607954f560fd4367b261f2e2bf11"},
		{"acc_01HXYZ", "tunelo.42", "m-a9c1fa870c0b342929392f97d7b27a"},
		{"acc_tiếng", "tunelo.123456789", "m-70114275f29d1222434a3e042afe3e"},
	} {
		if got := MachineSubdomain(v.sub, v.device); got != v.want {
			t.Errorf("MachineSubdomain(%q, %q) = %s, want %s", v.sub, v.device, got, v.want)
		}
	}
	if got := machineDeviceID(42); got != "tunelo.42" {
		t.Errorf("machineDeviceID(42) = %s", got)
	}
}

func TestHeartbeat(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	id, secret := e.legacy()
	beat := &appv1.HeartbeatRequest{TunnelUrl: "wss://dat-mac.tunnel.hoandat.com/", AgentVersion: "2.1.2", ClaudeVersion: "2.1.319"}

	for name, header := range map[string]string{"none": "", "not bearer": "Basic " + secret, "wrong": "Bearer " + wrong(secret)} {
		req := connect.NewRequest(beat)
		if header != "" {
			req.Header().Set("Authorization", header)
		}
		if _, err := e.client.Heartbeat(ctx, req); connect.CodeOf(err) != connect.CodeUnauthenticated {
			t.Errorf("%s: %v", name, err)
		}
	}
	for _, url := range []string{
		"https://dat.tunnel.hoandat.com", "wss://dat.tunnel.evil.com", "wss://a.b.tunnel.hoandat.com",
		"wss://DAT.tunnel.hoandat.com", "wss://dat.tunnel.hoandat.com/x", "wss://dat.tunnel.hoandat.com.evil.com",
	} {
		if _, err := e.client.Heartbeat(ctx, withSecret(&appv1.HeartbeatRequest{TunnelUrl: url, AgentVersion: "2.1.0"}, secret)); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Errorf("tunnel %q: %v", url, err)
		}
	}
	if _, err := e.client.Heartbeat(ctx, withSecret(&appv1.HeartbeatRequest{AgentVersion: "2.0.15"}, secret)); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("old agent: %v", err)
	}

	resp, err := e.client.Heartbeat(ctx, withSecret(beat, secret))
	if err != nil {
		t.Fatal(err)
	}
	if resp.Msg.GetRevoked() || len(resp.Msg.GetRevokedDeviceKeys()) != 0 || resp.Msg.GetMinAgentVersion() != MinAgentVersion {
		t.Fatalf("answer %+v", resp.Msg)
	}
	list, _ := e.store.ListMachines(ctx, tenant, e.userID)
	if list[0].TunnelURL != "wss://dat-mac.tunnel.hoandat.com" || list[0].AgentVersion != "2.1.2" || list[0].ClaudeVersion != "2.1.319" {
		t.Fatalf("recorded %+v", list[0])
	}

	phone := bytes.Repeat([]byte{9}, 32)
	if err := e.store.RevokeMachineDevice(ctx, tenant, e.userID, id, phone); err != nil {
		t.Fatal(err)
	}
	resp, err = e.client.Heartbeat(ctx, withSecret(beat, secret))
	if err != nil || len(resp.Msg.GetRevokedDeviceKeys()) != 1 || !bytes.Equal(resp.Msg.GetRevokedDeviceKeys()[0], phone) {
		t.Fatalf("revoked device: %+v %v", resp, err)
	}

	if err := e.store.RevokeMachine(ctx, tenant, e.userID, id); err != nil {
		t.Fatal(err)
	}
	// A revoked machine is told so, whatever version it runs.
	resp, err = e.client.Heartbeat(ctx, withSecret(&appv1.HeartbeatRequest{AgentVersion: "0.0.1"}, secret))
	if err != nil || !resp.Msg.GetRevoked() {
		t.Fatalf("revoked machine: %+v %v", resp, err)
	}
	_, err = e.client.NotifyNeedsInput(ctx, withSecret(&appv1.NotifyNeedsInputRequest{
		Kind: appv1.NeedsInputKind_NEEDS_INPUT_KIND_APPROVAL, PendingCount: 1}, secret))
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("notice of a revoked machine: %v", err)
	}
}

func TestNotifyNeedsInputMerges(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	id, secret := e.register()
	notify := func(kind appv1.NeedsInputKind, pending int32, session string) error {
		_, err := e.client.NotifyNeedsInput(ctx, withSecret(&appv1.NotifyNeedsInputRequest{
			Kind: kind, PendingCount: pending, SessionId: session}, secret))
		return err
	}
	for name, err := range map[string]error{
		"no kind":       notify(appv1.NeedsInputKind_NEEDS_INPUT_KIND_UNSPECIFIED, 1, ""),
		"none pending":  notify(appv1.NeedsInputKind_NEEDS_INPUT_KIND_APPROVAL, 0, ""),
		"too many":      notify(appv1.NeedsInputKind_NEEDS_INPUT_KIND_APPROVAL, 1001, ""),
		"bad session":   notify(appv1.NeedsInputKind_NEEDS_INPUT_KIND_APPROVAL, 1, "a/b"),
		"long session":  notify(appv1.NeedsInputKind_NEEDS_INPUT_KIND_APPROVAL, 1, string(bytes.Repeat([]byte("a"), 65))),
		"text in place": notify(appv1.NeedsInputKind_NEEDS_INPUT_KIND_APPROVAL, 1, "rm -rf"),
	} {
		if connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := e.client.NotifyNeedsInput(ctx, connect.NewRequest(&appv1.NotifyNeedsInputRequest{
		Kind: appv1.NeedsInputKind_NEEDS_INPUT_KIND_APPROVAL, PendingCount: 1})); connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("without the secret: %v", err)
	}

	// The first notice goes out at once.
	if err := notify(appv1.NeedsInputKind_NEEDS_INPUT_KIND_APPROVAL, 1, "t_1"); err != nil {
		t.Fatal(err)
	}
	sent := e.notifier.take()
	want := push.MachineNotice{MachineID: id, MachineName: "Mac mini", Kind: push.MachineApproval, Pending: 1, SessionID: "t_1", At: e.now()}
	if len(sent) != 1 || sent[0] != want || e.notifier.users()[0] != e.userID {
		t.Fatalf("first push %+v", sent)
	}
	// Within the window: kept and merged, the newest count wins.
	e.advance(10 * time.Second)
	if err := notify(appv1.NeedsInputKind_NEEDS_INPUT_KIND_QUESTION, 2, "t_2"); err != nil {
		t.Fatal(err)
	}
	e.advance(5 * time.Second)
	if err := notify(appv1.NeedsInputKind_NEEDS_INPUT_KIND_APPROVAL, 3, "t_3"); err != nil {
		t.Fatal(err)
	}
	if sent, timers := e.notifier.take(), e.pending(); len(sent) != 0 || len(timers) != 1 || timers[0].after != 20*time.Second {
		t.Fatalf("pushed within the window: %+v, timers %d", sent, len(timers))
	}
	e.advance(15 * time.Second)
	e.pending()[0].fire()
	sent = e.notifier.take()
	if len(sent) != 1 || sent[0].Pending != 3 || sent[0].SessionID != "t_3" || !sent[0].At.Equal(e.now()) {
		t.Fatalf("merged push %+v", sent)
	}
	// The merged push opened a new window.
	e.advance(29 * time.Second)
	if err := notify(appv1.NeedsInputKind_NEEDS_INPUT_KIND_APPROVAL, 1, ""); err != nil {
		t.Fatal(err)
	}
	if sent := e.notifier.take(); len(sent) != 0 || len(e.pending()) != 2 {
		t.Fatalf("pushed within the merged push's window: %+v", sent)
	}
	// Closing stops what is kept.
	e.svc.Close()
	if !e.pending()[1].stopped {
		t.Fatal("pending push not stopped")
	}
	e.pending()[1].fire()
	if sent := e.notifier.take(); len(sent) != 0 {
		t.Fatalf("pushed after Close: %+v", sent)
	}
}

func TestNotifyDevicePairedGoesOutAtOnce(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	id, secret := e.register()
	notify := func(kind appv1.NeedsInputKind, pending int32, session string) error {
		_, err := e.client.NotifyNeedsInput(ctx, withSecret(&appv1.NotifyNeedsInputRequest{
			Kind: kind, PendingCount: pending, SessionId: session}, secret))
		return err
	}
	for name, err := range map[string]error{
		"no count":   notify(appv1.NeedsInputKind_NEEDS_INPUT_KIND_DEVICE_PAIRED, 0, ""),
		"count":      notify(appv1.NeedsInputKind_NEEDS_INPUT_KIND_DEVICE_PAIRED, 2, ""),
		"session":    notify(appv1.NeedsInputKind_NEEDS_INPUT_KIND_DEVICE_PAIRED, 1, "t_1"),
		"bad kind 4": notify(appv1.NeedsInputKind(4), 1, ""),
	} {
		if connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Errorf("%s: %v", name, err)
		}
	}
	if sent := e.notifier.take(); len(sent) != 0 {
		t.Fatalf("pushed on invalid calls: %+v", sent)
	}

	// A "needs you" push opens the machine's window ...
	if err := notify(appv1.NeedsInputKind_NEEDS_INPUT_KIND_APPROVAL, 1, "t_1"); err != nil {
		t.Fatal(err)
	}
	e.notifier.take()
	e.advance(5 * time.Second)
	if err := notify(appv1.NeedsInputKind_NEEDS_INPUT_KIND_QUESTION, 2, "t_2"); err != nil {
		t.Fatal(err)
	}
	// ... but a newly paired device is told at once and keeps the merged one.
	if err := notify(appv1.NeedsInputKind_NEEDS_INPUT_KIND_DEVICE_PAIRED, 1, ""); err != nil {
		t.Fatal(err)
	}
	sent := e.notifier.take()
	want := push.MachineNotice{MachineID: id, MachineName: "Mac mini", Kind: push.MachineDevicePaired, Pending: 1, At: e.now()}
	if len(sent) != 1 || sent[0] != want {
		t.Fatalf("device paired push %+v", sent)
	}
	timers := e.pending()
	if len(timers) != 1 {
		t.Fatalf("merged push lost: %d timers", len(timers))
	}
	e.advance(25 * time.Second)
	timers[0].fire()
	if sent := e.notifier.take(); len(sent) != 1 || sent[0].Kind != push.MachineQuestion || sent[0].SessionID != "t_2" {
		t.Fatalf("merged push %+v", sent)
	}
	// Not after Close.
	e.svc.Close()
	if err := notify(appv1.NeedsInputKind_NEEDS_INPUT_KIND_DEVICE_PAIRED, 1, ""); err != nil {
		t.Fatal(err)
	}
	if sent := e.notifier.take(); len(sent) != 0 {
		t.Fatalf("pushed after Close: %+v", sent)
	}
}

func TestFailedAuthenticationsAreLimited(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	_, secret := e.register()
	var last error
	for range 25 {
		_, last = e.client.Heartbeat(ctx, withSecret(&appv1.HeartbeatRequest{AgentVersion: "2.1.0"}, wrong(secret)))
	}
	if connect.CodeOf(last) != connect.CodeResourceExhausted {
		t.Fatalf("after many failures: %v", last)
	}
	// A valid secret still passes.
	if _, err := e.client.Heartbeat(ctx, withSecret(&appv1.HeartbeatRequest{AgentVersion: "2.1.0"}, secret)); err != nil {
		t.Fatal(err)
	}
}

func TestCheckVersion(t *testing.T) {
	for v, want := range map[string]connect.Code{
		"2.1.0": 0, "2.1.0-beta.1": 0, "2.1.1": 0, "2.2.0": 0, "3.0.0": 0,
		// Before device link protocol 2: refused with a clear "run tunelo update".
		"2.0.15": connect.CodeFailedPrecondition, "2.0.99": connect.CodeFailedPrecondition,
		"1.9.1": connect.CodeFailedPrecondition, "0.1.0": connect.CodeFailedPrecondition,
		"": connect.CodeInvalidArgument, "2.1": connect.CodeInvalidArgument, "02.1.0": connect.CodeInvalidArgument,
		"2.1.0+build": connect.CodeInvalidArgument,
	} {
		if got := connect.CodeOf(checkVersion(v)); checkVersion(v) == nil && want != 0 || checkVersion(v) != nil && got != want {
			t.Errorf("checkVersion(%q) = %v, want %v", v, checkVersion(v), want)
		}
	}
	// An older tunelo reads what to do from the message.
	if err := checkVersion("2.0.15"); err == nil || !strings.Contains(err.Error(), "agent_update_required: tunelo 2.1.0 or newer is required; run tunelo update") {
		t.Errorf("old agent message: %v", err)
	}
}
