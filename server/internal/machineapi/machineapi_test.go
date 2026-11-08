package machineapi

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/push"
	"app.local/server/internal/ratelimit"
	"app.local/server/internal/store"
	"app.local/server/internal/store/testdb"
	"connectrpc.com/connect"
)

const tenant = "primary"

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
	u, err := st.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_1", PreferredUsername: "dat"})
	if err != nil {
		t.Fatal(err)
	}
	e := &env{t: t, store: st, notifier: &notifier{}, userID: u.ID, clock: time.Unix(1_800_000_000, 0)}
	e.svc, err = New(Config{TenantID: tenant, TenantDomain: "hoandat.com"}, st, e.notifier, ratelimit.NewMemory(), quiet)
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
	// A plain client, as chat-agent: no Origin, no cookie.
	e.client = appv1connect.NewMachineAgentServiceClient(srv.Client(), srv.URL+"/machine-api")
	return e
}

func (e *env) code() string {
	e.t.Helper()
	code, _, err := e.store.CreateInstallCode(context.Background(), tenant, e.userID)
	if err != nil {
		e.t.Fatal(err)
	}
	return code
}

func registerRequest(code string) *appv1.RegisterMachineRequest {
	return &appv1.RegisterMachineRequest{InstallCode: code, Name: " Mac mini ", Os: "darwin", Arch: "arm64",
		AgentVersion: "0.1.0", PublicKey: bytes.Repeat([]byte{5}, 32)}
}

func (e *env) register() (int64, string) {
	e.t.Helper()
	resp, err := e.client.RegisterMachine(context.Background(), connect.NewRequest(registerRequest(e.code())))
	if err != nil {
		e.t.Fatal(err)
	}
	return resp.Msg.GetMachineId(), resp.Msg.GetMachineSecret()
}

func withSecret[T any](msg *T, secret string) *connect.Request[T] {
	req := connect.NewRequest(msg)
	req.Header().Set("Authorization", "Bearer "+secret)
	return req
}

func TestRegisterMachine(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	code := e.code()
	for name, msg := range map[string]*appv1.RegisterMachineRequest{
		"no name":     {InstallCode: code, Os: "darwin", Arch: "arm64", AgentVersion: "0.1.0", PublicKey: make([]byte, 32)},
		"bad os":      {InstallCode: code, Name: "m", Os: "freebsd", Arch: "arm64", AgentVersion: "0.1.0", PublicKey: make([]byte, 32)},
		"bad arch":    {InstallCode: code, Name: "m", Os: "darwin", Arch: "ia32", AgentVersion: "0.1.0", PublicKey: make([]byte, 32)},
		"bad version": {InstallCode: code, Name: "m", Os: "darwin", Arch: "arm64", AgentVersion: "v1", PublicKey: make([]byte, 32)},
		"short key":   {InstallCode: code, Name: "m", Os: "darwin", Arch: "arm64", AgentVersion: "0.1.0", PublicKey: make([]byte, 31)},
	} {
		if _, err := e.client.RegisterMachine(ctx, connect.NewRequest(msg)); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Errorf("%s: %v", name, err)
		}
	}
	old := registerRequest(code)
	old.AgentVersion = "0.0.9"
	if _, err := e.client.RegisterMachine(ctx, connect.NewRequest(old)); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("old agent: %v", err)
	}
	for _, bad := range []string{"", "short", "AAAAAAAAAAAAAAAAAAAAAA"} {
		if _, err := e.client.RegisterMachine(ctx, connect.NewRequest(registerRequest(bad))); connect.CodeOf(err) != connect.CodeUnauthenticated {
			t.Fatalf("code %q: %v", bad, err)
		}
	}
	resp, err := e.client.RegisterMachine(ctx, connect.NewRequest(registerRequest(code)))
	if err != nil {
		t.Fatal(err)
	}
	if resp.Msg.GetMachineId() <= 0 || len(resp.Msg.GetMachineSecret()) != 43 {
		t.Fatalf("answer %+v", resp.Msg)
	}
	list, err := e.store.ListMachines(ctx, tenant, e.userID)
	if err != nil || len(list) != 1 || list[0].Name != "Mac mini" {
		t.Fatalf("directory %+v %v", list, err)
	}
	if _, err := e.client.RegisterMachine(ctx, connect.NewRequest(registerRequest(code))); connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("code used twice: %v", err)
	}
}

func TestHeartbeat(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	id, secret := e.register()
	beat := &appv1.HeartbeatRequest{TunnelUrl: "wss://dat-mac.tunnel.hoandat.com/", AgentVersion: "0.1.2", ClaudeVersion: "2.1.319"}

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
		if _, err := e.client.Heartbeat(ctx, withSecret(&appv1.HeartbeatRequest{TunnelUrl: url, AgentVersion: "0.1.0"}, secret)); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Errorf("tunnel %q: %v", url, err)
		}
	}
	if _, err := e.client.Heartbeat(ctx, withSecret(&appv1.HeartbeatRequest{AgentVersion: "0.0.1"}, secret)); connect.CodeOf(err) != connect.CodeFailedPrecondition {
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
	if list[0].TunnelURL != "wss://dat-mac.tunnel.hoandat.com" || list[0].AgentVersion != "0.1.2" || list[0].ClaudeVersion != "2.1.319" {
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

func TestFailedAuthenticationsAreLimited(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	_, secret := e.register()
	var last error
	for range 25 {
		_, last = e.client.Heartbeat(ctx, withSecret(&appv1.HeartbeatRequest{AgentVersion: "0.1.0"}, wrong(secret)))
	}
	if connect.CodeOf(last) != connect.CodeResourceExhausted {
		t.Fatalf("after many failures: %v", last)
	}
	// A valid secret still passes.
	if _, err := e.client.Heartbeat(ctx, withSecret(&appv1.HeartbeatRequest{AgentVersion: "0.1.0"}, secret)); err != nil {
		t.Fatal(err)
	}
}

func TestCheckVersion(t *testing.T) {
	for v, want := range map[string]connect.Code{
		"0.1.0": 0, "0.1.0-beta.1": 0, "0.2.0": 0, "1.0.0": 0, "0.0.9": connect.CodeFailedPrecondition,
		"": connect.CodeInvalidArgument, "0.1": connect.CodeInvalidArgument, "01.1.0": connect.CodeInvalidArgument,
		"0.1.0+build": connect.CodeInvalidArgument,
	} {
		if got := connect.CodeOf(checkVersion(v)); checkVersion(v) == nil && want != 0 || checkVersion(v) != nil && got != want {
			t.Errorf("checkVersion(%q) = %v, want %v", v, checkVersion(v), want)
		}
	}
}
