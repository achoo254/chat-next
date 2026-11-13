package machineapi

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
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
	"app.local/server/internal/keyproof"
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

// kicker counts the calls of Kick.
type kicker struct {
	mu    sync.Mutex
	kicks int
}

func (k *kicker) Kick() {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.kicks++
}

func (k *kicker) count() int {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.kicks
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
	grants   *kicker
	// machineKey is the machine's X25519 key: registerRequest proves it.
	machineKey *ecdh.PrivateKey

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
	proofs, err := keyproof.New(bytes.Repeat([]byte{4}, 32))
	if err != nil {
		t.Fatal(err)
	}
	e := &env{t: t, store: st, notifier: &notifier{}, idp: provider, userID: u.ID, clock: time.Unix(1_800_000_000, 0),
		grants: &kicker{}, machineKey: newKey(t)}
	e.svc, err = New(Config{TenantID: tenant, TenantDomain: "hoandat.com", Resource: resource, KeyProofs: proofs, Grants: e.grants},
		st, verifier, e.notifier, ratelimit.NewMemory(), quiet)
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
		"grant_id": "grant-of-" + sub,
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

func newKey(t *testing.T) *ecdh.PrivateKey {
	t.Helper()
	k, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

// prove answers c with key, as tunelo does.
func prove(t *testing.T, key *ecdh.PrivateKey, c *appv1.KeyChallenge) *appv1.KeyProof {
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

// registerRequestFor registers key, with a proof of it.
func (e *env) registerRequestFor(key *ecdh.PrivateKey) *appv1.RegisterMachineRequest {
	e.t.Helper()
	c, err := e.svc.cfg.KeyProofs.Challenge(keyproof.Machine)
	if err != nil {
		e.t.Fatal(err)
	}
	return &appv1.RegisterMachineRequest{Name: " Mac mini ", Os: "darwin", Arch: "arm64",
		AgentVersion: "3.3.0", PublicKey: key.PublicKey().Bytes(), Proof: prove(e.t, key, c)}
}

func (e *env) registerRequest() *appv1.RegisterMachineRequest {
	return e.registerRequestFor(e.machineKey)
}

func (e *env) register() (int64, string) {
	e.t.Helper()
	resp, err := e.client.RegisterMachine(context.Background(), withSecret(e.registerRequest(), e.token(ownerSub)))
	if err != nil {
		e.t.Fatal(err)
	}
	return resp.Msg.GetMachineId(), resp.Msg.GetMachineSecret()
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
		req := connect.NewRequest(e.registerRequest())
		if tok != "" {
			req.Header().Set("Authorization", "Bearer "+tok)
		}
		if _, err := e.client.RegisterMachine(ctx, req); connect.CodeOf(err) != connect.CodeUnauthenticated {
			t.Errorf("%s: %v", name, err)
		}
	}
	noScope := e.token(ownerSub, func(c map[string]any) string { c["scope"] = "chat:read chat:write"; return "" })
	if _, err := e.client.RegisterMachine(ctx, withSecret(e.registerRequest(), noScope)); connect.CodeOf(err) != connect.CodePermissionDenied ||
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
	if _, err := e.client.RegisterMachine(ctx, withSecret(e.registerRequest(), forged)); connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("token of a foreign key: %v", err)
	}

	tok := e.token(ownerSub)
	for name, msg := range map[string]*appv1.RegisterMachineRequest{
		"no name":     {Os: "darwin", Arch: "arm64", AgentVersion: "3.3.0", PublicKey: make([]byte, 32)},
		"bad os":      {Name: "m", Os: "freebsd", Arch: "arm64", AgentVersion: "3.3.0", PublicKey: make([]byte, 32)},
		"bad arch":    {Name: "m", Os: "darwin", Arch: "ia32", AgentVersion: "3.3.0", PublicKey: make([]byte, 32)},
		"bad version": {Name: "m", Os: "darwin", Arch: "arm64", AgentVersion: "v1", PublicKey: make([]byte, 32)},
		"short key":   {Name: "m", Os: "darwin", Arch: "arm64", AgentVersion: "3.3.0", PublicKey: make([]byte, 31)},
	} {
		if _, err := e.client.RegisterMachine(ctx, withSecret(msg, tok)); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Errorf("%s: %v", name, err)
		}
	}
	old := e.registerRequest()
	old.AgentVersion = "2.7.1"
	if _, err := e.client.RegisterMachine(ctx, withSecret(old, tok)); connect.CodeOf(err) != connect.CodeFailedPrecondition ||
		!strings.Contains(err.Error(), "run the install command") {
		t.Fatalf("old agent: %v", err)
	}
	// The key must be proven: no proof, a proof of another key, or one made
	// for a device challenge are all refused.
	noProof := e.registerRequest()
	noProof.Proof = nil
	otherKey := e.registerRequest()
	otherKey.Proof = e.registerRequestFor(newKey(t)).GetProof()
	deviceChallenge, err := e.svc.cfg.KeyProofs.Challenge(keyproof.AccountDevice)
	if err != nil {
		t.Fatal(err)
	}
	wrongPurpose := e.registerRequest()
	wrongPurpose.Proof = prove(t, e.machineKey, deviceChallenge)
	for name, msg := range map[string]*appv1.RegisterMachineRequest{"no proof": noProof, "other key": otherKey, "device challenge": wrongPurpose} {
		if _, err := e.client.RegisterMachine(ctx, withSecret(msg, tok)); connect.CodeOf(err) != connect.CodePermissionDenied ||
			!strings.Contains(err.Error(), "bad_key_proof") {
			t.Errorf("%s: %v", name, err)
		}
	}
	resp, err := e.client.RegisterMachine(ctx, withSecret(e.registerRequest(), tok))
	if err != nil {
		t.Fatal(err)
	}
	if resp.Msg.GetMachineId() <= 0 || len(resp.Msg.GetMachineSecret()) != 43 {
		t.Fatalf("answer %+v", resp.Msg)
	}
	list, err := e.store.ListMachines(ctx, tenant, e.userID)
	if err != nil || len(list) != 1 || list[0].Name != "Mac mini" || !list[0].Claimed ||
		!bytes.Equal(list[0].PublicKey, e.machineKey.PublicKey().Bytes()) {
		t.Fatalf("directory %+v %v", list, err)
	}
	var grant string
	if err := e.store.Pool().QueryRow(ctx, `SELECT idp_grant_id FROM machines WHERE id = $1`, resp.Msg.GetMachineId()).Scan(&grant); err != nil ||
		grant != "grant-of-"+ownerSub {
		t.Fatalf("grant %q %v", grant, err)
	}
}

// The challenge comes from the service with the owner's token; registering
// the same key again keeps the machine and rotates its secret.
func TestRegisterMachineAgainWithChallenge(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	if _, err := e.client.GetMachineKeyChallenge(ctx, connect.NewRequest(&appv1.GetMachineKeyChallengeRequest{})); connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("challenge without a token: %v", err)
	}
	noScope := e.token(ownerSub, func(c map[string]any) string { c["scope"] = "chat:read"; return "" })
	if _, err := e.client.GetMachineKeyChallenge(ctx, withSecret(&appv1.GetMachineKeyChallengeRequest{}, noScope)); connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("challenge without machines:write: %v", err)
	}
	id, oldSecret := e.register()
	c, err := e.client.GetMachineKeyChallenge(ctx, withSecret(&appv1.GetMachineKeyChallengeRequest{}, e.token(ownerSub)))
	if err != nil {
		t.Fatal(err)
	}
	req := &appv1.RegisterMachineRequest{Name: "new host name", Os: "darwin", Arch: "arm64", AgentVersion: "3.3.1",
		PublicKey: e.machineKey.PublicKey().Bytes(), Proof: prove(t, e.machineKey, c.Msg.GetChallenge())}
	resp, err := e.client.RegisterMachine(ctx, withSecret(req, e.token(ownerSub)))
	if err != nil || resp.Msg.GetMachineId() != id || resp.Msg.GetMachineSecret() == oldSecret {
		t.Fatalf("registered again: %+v %v", resp, err)
	}
	if _, err := e.client.Heartbeat(ctx, withSecret(&appv1.HeartbeatRequest{AgentVersion: "3.3.1"}, oldSecret)); connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("the old secret still works: %v", err)
	}
	if list, _ := e.store.ListMachines(ctx, tenant, e.userID); len(list) != 1 || list[0].Name != "Mac mini" {
		t.Fatalf("directory %+v", list)
	}
}

func TestRegisterMachineCreatesTheChatUser(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	// New accounts refused (sign-up caps): a reason of its own, so tunelo waits.
	var asked []string
	e.svc.cfg.AdmitNewUser = func(ip string) bool { asked = append(asked, ip); return false }
	_, err := e.client.RegisterMachine(ctx, withSecret(e.registerRequest(), e.token("acc_new")))
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
	resp, err := e.client.RegisterMachine(ctx, withSecret(e.registerRequest(), e.token("acc_new")))
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
	e.machineKey = newKey(t)
	if _, err := e.client.RegisterMachine(ctx, withSecret(e.registerRequest(), e.token(ownerSub))); err != nil {
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
			tenant, e.userID, bytes.Repeat([]byte{byte(100 + i)}, 32), bytes.Repeat([]byte{byte(i + 1)}, 32)); err != nil {
			t.Fatal(err)
		}
	}
	tok := e.token(ownerSub)
	// Two different machines at once: one fits.
	reqs := []*appv1.RegisterMachineRequest{e.registerRequestFor(newKey(t)), e.registerRequestFor(newKey(t))}
	errs := make([]error, 2)
	var wg sync.WaitGroup
	for i := range errs {
		wg.Go(func() {
			_, errs[i] = e.client.RegisterMachine(ctx, withSecret(reqs[i], tok))
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
			tenant, e.userID, bytes.Repeat([]byte{byte(100 + i)}, 32), bytes.Repeat([]byte{byte(i + 1)}, 32)); err != nil {
			t.Fatal(err)
		}
	}
	// The registered machine comes back at the limit; a new one does not fit.
	if _, err := e.client.RegisterMachine(ctx, withSecret(e.registerRequest(), e.token(ownerSub))); err != nil {
		t.Fatalf("the same machine again: %v", err)
	}
	_, err := e.client.RegisterMachine(ctx, withSecret(e.registerRequestFor(newKey(t)), e.token(ownerSub)))
	if connect.CodeOf(err) != connect.CodeResourceExhausted || !strings.Contains(err.Error(), "too_many_machines") {
		t.Fatalf("the 21st machine: %v", err)
	}
}

func TestRegisteredMachineTunnelIsChecked(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	id, secret := e.register()
	beat := func(tunnel string) (bool, error) {
		r, err := e.client.Heartbeat(ctx, withSecret(&appv1.HeartbeatRequest{TunnelUrl: tunnel, AgentVersion: "3.3.0"}, secret))
		if err != nil {
			return false, err
		}
		return r.Msg.GetTunnelRefused(), nil
	}
	// Only the machine tunnel of the owner's account is listed. Another one
	// is refused without failing the heartbeat: the machine stays alive
	// without a tunnel.
	for _, tunnel := range []string{"wss://dat-mac.tunnel.hoandat.com", machineTunnel("acc_2", id), machineTunnel(ownerSub, id+1)} {
		if refused, err := beat(tunnel); err != nil || !refused {
			t.Errorf("tunnel %s: %v %v", tunnel, refused, err)
		}
		if list, _ := e.store.ListMachines(ctx, tenant, e.userID); list[0].TunnelURL != "" {
			t.Fatalf("a refused tunnel was listed: %q", list[0].TunnelURL)
		}
	}
	if refused, err := beat(machineTunnel(ownerSub, id) + "/"); err != nil || refused {
		t.Fatalf("own tunnel: %v %v", refused, err)
	}
	if list, _ := e.store.ListMachines(ctx, tenant, e.userID); list[0].TunnelURL != machineTunnel(ownerSub, id) {
		t.Fatalf("own tunnel recorded %q", list[0].TunnelURL)
	}
}

// What the agent sends stays metadata: no session content, no secret of the
// end-to-end link. Any new field fails here first, to be weighed.
func TestAgentCallFields(t *testing.T) {
	for msg, want := range map[proto.Message][]string{
		&appv1.RegisterMachineRequest{}:   {"name", "os", "arch", "agent_version", "public_key", "proof"},
		&appv1.HeartbeatRequest{}:         {"tunnel_url", "agent_version", "connected_device_keys"},
		&appv1.NotifyNeedsInputRequest{}:  {"kind", "pending_count", "session_id", "provider_id"},
		&appv1.UnregisterMachineRequest{}: nil,
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
	id, secret := e.register()
	tunnel := machineTunnel(ownerSub, id)
	beat := &appv1.HeartbeatRequest{TunnelUrl: tunnel + "/", AgentVersion: "3.3.1"}

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
		if _, err := e.client.Heartbeat(ctx, withSecret(&appv1.HeartbeatRequest{TunnelUrl: url, AgentVersion: "3.3.0"}, secret)); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Errorf("tunnel %q: %v", url, err)
		}
	}
	for name, keys := range map[string][][]byte{
		"short key": {make([]byte, 31)},
		"too many":  slices.Repeat([][]byte{make([]byte, 32)}, store.MaxConnectedDeviceKeys+1),
	} {
		if _, err := e.client.Heartbeat(ctx, withSecret(&appv1.HeartbeatRequest{AgentVersion: "3.3.0", ConnectedDeviceKeys: keys}, secret)); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := e.client.Heartbeat(ctx, withSecret(&appv1.HeartbeatRequest{AgentVersion: "2.7.1"}, secret)); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("old agent: %v", err)
	}

	resp, err := e.client.Heartbeat(ctx, withSecret(beat, secret))
	if err != nil {
		t.Fatal(err)
	}
	if resp.Msg.GetRevoked() || len(resp.Msg.GetTrustedDevices()) != 0 || resp.Msg.GetMinAgentVersion() != MinAgentVersion {
		t.Fatalf("answer %+v", resp.Msg)
	}
	list, _ := e.store.ListMachines(ctx, tenant, e.userID)
	if list[0].TunnelURL != tunnel || list[0].AgentVersion != "3.3.1" {
		t.Fatalf("recorded %+v", list[0])
	}

	// The owner's devices come back; another account's never do.
	session := func(userID int64, token string) int64 {
		t.Helper()
		sum := sha256.Sum256([]byte(token))
		sid, err := e.store.CreateSession(ctx, store.NewSession{TokenHash: sum[:], TenantID: tenant, UserID: userID, IdPClientID: "chat-web"})
		if err != nil {
			t.Fatal(err)
		}
		return sid
	}
	other, err := e.store.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_2", PreferredUsername: "binh"})
	if err != nil {
		t.Fatal(err)
	}
	phone := bytes.Repeat([]byte{9}, 32)
	if _, _, err := e.store.RegisterAccountDevice(ctx, tenant, e.userID, session(e.userID, "phone"),
		store.NewAccountDevice{PublicKey: phone, Name: "iPhone", Platform: "ios"}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := e.store.RegisterAccountDevice(ctx, tenant, other.ID, session(other.ID, "theirs"),
		store.NewAccountDevice{PublicKey: bytes.Repeat([]byte{8}, 32), Name: "theirs", Platform: "web"}); err != nil {
		t.Fatal(err)
	}
	resp, err = e.client.Heartbeat(ctx, withSecret(beat, secret))
	if err != nil {
		t.Fatal(err)
	}
	got := resp.Msg.GetTrustedDevices()
	if len(got) != 1 || !bytes.Equal(got[0].GetPublicKey(), phone) || got[0].GetName() != "iPhone" || got[0].GetPlatform() != "ios" ||
		got[0].GetCreatedAt() == 0 {
		t.Fatalf("trusted devices %+v", got)
	}
	if _, err := e.store.RevokeAccountDevice(ctx, tenant, e.userID, phone); err != nil {
		t.Fatal(err)
	}
	if resp, err := e.client.Heartbeat(ctx, withSecret(beat, secret)); err != nil || len(resp.Msg.GetTrustedDevices()) != 0 {
		t.Fatalf("after revoking the device: %+v %v", resp, err)
	}

	if err := e.store.RevokeMachine(ctx, tenant, e.userID, id); err != nil {
		t.Fatal(err)
	}
	// A revoked machine is told so, whatever version it runs.
	resp, err = e.client.Heartbeat(ctx, withSecret(&appv1.HeartbeatRequest{AgentVersion: "0.0.1"}, secret))
	if err != nil || !resp.Msg.GetRevoked() || len(resp.Msg.GetTrustedDevices()) != 0 {
		t.Fatalf("revoked machine: %+v %v", resp, err)
	}
	_, err = e.client.NotifyNeedsInput(ctx, withSecret(&appv1.NotifyNeedsInputRequest{
		Kind: appv1.NeedsInputKind_NEEDS_INPUT_KIND_APPROVAL, PendingCount: 1}, secret))
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("notice of a revoked machine: %v", err)
	}
}

func TestUnregisterMachine(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	id, secret := e.register()
	if _, err := e.client.UnregisterMachine(ctx, withSecret(&appv1.UnregisterMachineRequest{}, wrong(secret))); connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("wrong secret: %v", err)
	}
	for range 2 {
		if _, err := e.client.UnregisterMachine(ctx, withSecret(&appv1.UnregisterMachineRequest{}, secret)); err != nil {
			t.Fatal(err)
		}
	}
	if e.grants.count() != 2 {
		t.Fatalf("grant revocation kicked %d times", e.grants.count())
	}
	if list, _ := e.store.ListMachines(ctx, tenant, e.userID); len(list) != 0 {
		t.Fatalf("still listed: %+v", list)
	}
	if resp, err := e.client.Heartbeat(ctx, withSecret(&appv1.HeartbeatRequest{AgentVersion: "3.3.0"}, secret)); err != nil || !resp.Msg.GetRevoked() {
		t.Fatalf("heartbeat after unregistering: %+v %v", resp, err)
	}
	pending, err := e.store.PendingGrantRevocations(ctx, tenant, 10)
	if err != nil || len(pending) != 1 || pending[0].MachineID != id || pending[0].GrantID != "grant-of-"+ownerSub {
		t.Fatalf("pending grant %+v %v", pending, err)
	}
	// Registering the key again makes a new machine.
	again, _ := e.register()
	if again == id {
		t.Fatal("the removed machine came back")
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

// The push names the waiting thread's AI only by an id the server checks;
// notices of one window that name different AIs merge into "AI" (empty).
func TestNotifyNeedsInputNamesTheAI(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	_, secret := e.register()
	notify := func(pending int32, provider string) {
		t.Helper()
		if _, err := e.client.NotifyNeedsInput(ctx, withSecret(&appv1.NotifyNeedsInputRequest{
			Kind: appv1.NeedsInputKind_NEEDS_INPUT_KIND_APPROVAL, PendingCount: pending, ProviderId: provider}, secret)); err != nil {
			t.Fatal(err)
		}
	}
	notify(1, "antigravity")
	if sent := e.notifier.take(); len(sent) != 1 || sent[0].Provider != "antigravity" {
		t.Fatalf("first push %+v", sent)
	}
	// A malformed id is dropped, never refused.
	e.advance(31 * time.Second)
	notify(1, "Claude Code!")
	if sent := e.notifier.take(); len(sent) != 1 || sent[0].Provider != "" {
		t.Fatalf("malformed id %+v", sent)
	}
	// One AI kept within the window keeps its name.
	e.advance(31 * time.Second)
	notify(1, "claude")
	e.notifier.take()
	e.advance(5 * time.Second)
	notify(2, "claude")
	e.pending()[len(e.pending())-1].fire()
	if sent := e.notifier.take(); len(sent) != 1 || sent[0].Provider != "claude" {
		t.Fatalf("same AI merged %+v", sent)
	}
	// Two AIs kept within one window: the push names neither.
	e.advance(31 * time.Second)
	notify(1, "claude")
	e.notifier.take()
	e.advance(5 * time.Second)
	notify(2, "claude")
	notify(3, "antigravity")
	e.pending()[len(e.pending())-1].fire()
	if sent := e.notifier.take(); len(sent) != 1 || sent[0].Provider != "" || sent[0].Pending != 3 {
		t.Fatalf("different AIs merged %+v", sent)
	}
}

func TestNotifyUsageHintNamesTheMachineOnly(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	id, secret := e.register()
	notify := func(pending int32, session string) error {
		_, err := e.client.NotifyNeedsInput(ctx, withSecret(&appv1.NotifyNeedsInputRequest{
			Kind: appv1.NeedsInputKind_NEEDS_INPUT_KIND_USAGE_HINT, PendingCount: pending, SessionId: session}, secret))
		return err
	}
	for name, err := range map[string]error{
		"no count":       notify(0, ""),
		"count":          notify(2, ""),
		"session":        notify(1, "t_1"),
		"retired kind 3": notifyKind(e, secret, appv1.NeedsInputKind(3)),
		"bad kind 5":     notifyKind(e, secret, appv1.NeedsInputKind(5)),
	} {
		if connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Errorf("%s: %v", name, err)
		}
	}
	if sent := e.notifier.take(); len(sent) != 0 {
		t.Fatalf("pushed on invalid calls: %+v", sent)
	}

	// A "needs you" push opens the machine's window; a usage hint goes out at
	// once beside it and leaves the merged one waiting.
	if _, err := e.client.NotifyNeedsInput(ctx, withSecret(&appv1.NotifyNeedsInputRequest{
		Kind: appv1.NeedsInputKind_NEEDS_INPUT_KIND_APPROVAL, PendingCount: 1, SessionId: "t_1"}, secret)); err != nil {
		t.Fatal(err)
	}
	e.notifier.take()
	e.advance(5 * time.Second)
	if _, err := e.client.NotifyNeedsInput(ctx, withSecret(&appv1.NotifyNeedsInputRequest{
		Kind: appv1.NeedsInputKind_NEEDS_INPUT_KIND_QUESTION, PendingCount: 2, SessionId: "t_2"}, secret)); err != nil {
		t.Fatal(err)
	}
	if err := notify(1, ""); err != nil {
		t.Fatal(err)
	}
	sent := e.notifier.take()
	want := push.MachineNotice{MachineID: id, MachineName: "Mac mini", Kind: push.MachineUsageHint, Pending: 1, At: e.now()}
	if len(sent) != 1 || sent[0] != want {
		t.Fatalf("usage hint push %+v", sent)
	}
	if timers := e.pending(); len(timers) != 1 {
		t.Fatalf("merged push lost: %d timers", len(timers))
	}
}

func notifyKind(e *env, secret string, kind appv1.NeedsInputKind) error {
	_, err := e.client.NotifyNeedsInput(context.Background(), withSecret(&appv1.NotifyNeedsInputRequest{Kind: kind, PendingCount: 1}, secret))
	return err
}

func TestFailedAuthenticationsAreLimited(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	_, secret := e.register()
	var last error
	for range 25 {
		_, last = e.client.Heartbeat(ctx, withSecret(&appv1.HeartbeatRequest{AgentVersion: "3.3.0"}, wrong(secret)))
	}
	if connect.CodeOf(last) != connect.CodeResourceExhausted {
		t.Fatalf("after many failures: %v", last)
	}
	// A valid secret still passes.
	if _, err := e.client.Heartbeat(ctx, withSecret(&appv1.HeartbeatRequest{AgentVersion: "3.3.0"}, secret)); err != nil {
		t.Fatal(err)
	}
}

func TestCheckVersion(t *testing.T) {
	for v, want := range map[string]connect.Code{
		"3.3.0": 0, "3.3.1": 0, "3.4.0": 0, "4.0.0": 0, "3.3.0-beta.1": 0,
		"3.2.2": connect.CodeFailedPrecondition, "3.0.0": connect.CodeFailedPrecondition,
		// Older than the minimum: refused with what to do.
		"2.7.1": connect.CodeFailedPrecondition, "2.2.2": connect.CodeFailedPrecondition, "2.0.15": connect.CodeFailedPrecondition,
		"1.9.1": connect.CodeFailedPrecondition, "0.1.0": connect.CodeFailedPrecondition,
		"": connect.CodeInvalidArgument, "2.1": connect.CodeInvalidArgument, "02.1.0": connect.CodeInvalidArgument,
		"2.1.0+build": connect.CodeInvalidArgument,
	} {
		if got := connect.CodeOf(checkVersion(v)); checkVersion(v) == nil && want != 0 || checkVersion(v) != nil && got != want {
			t.Errorf("checkVersion(%q) = %v, want %v", v, checkVersion(v), want)
		}
	}
	// An older tunelo reads what to do from the message.
	if err := checkVersion("2.7.1"); err == nil ||
		!strings.Contains(err.Error(), "agent_update_required: tunelo 3.3.0 or newer is required; run the install command on the chat's Machines page again") {
		t.Errorf("old agent message: %v", err)
	}
}
