// Package machineapi serves the calls of tunelo, the
// background process of "My machines" (ADR 0013), under /machine-api/ as the
// Connect service app.v1.MachineAgentService: GetMachineKeyChallenge and
// RegisterMachine (authenticated by an IdP access token of the owner, aud
// the chat's MCP resource, scope machines:write), Heartbeat,
// NotifyNeedsInput and UnregisterMachine (by the machine secret in
// "Authorization: Bearer <secret>").
//
// It is mounted beside /rpc, not inside it: the agent sends no Origin and
// has no user session, so the Origin and session checks of /rpc do not
// apply. The machine secret reports the machine alive, asks for
// content-free pushes and reads the owner's trusted device keys (public
// keys, names and platforms); it reads no chat data. A machine proves it
// holds its key when it registers (package keyproof), so the key the
// directory lists to devices is the machine's own.
//
// A machine gets listed only with the machine tunnel Tunelo holds for its
// owner's account (MachineSubdomain), so the directory never points devices
// at a tunnel another account opened.
//
// Secrets and tokens never reach a log. Failed authentications are
// limited per client address (a valid secret is never refused by that
// limit); nginx also limits the paths, RegisterMachine per address and
// overall. A machine's "needs you" pushes go out at most once per
// notifyWindow: calls in between are merged into one push sent when the
// window ends, carrying the newest pending count.
package machineapi

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/auth"
	"app.local/server/internal/keyproof"
	"app.local/server/internal/protoids"
	"app.local/server/internal/push"
	"app.local/server/internal/ratelimit"
	"app.local/server/internal/store"
	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
)

// Prefix is where the handler is mounted; procedures live at
// /machine-api/app.v1.MachineAgentService/<Method>.
const Prefix = "/machine-api/"

// MinAgentVersion is the oldest machine agent (tunelo) the server accepts:
// 3.0.0 speaks device link protocol 3 (devices trusted through the owner's
// account), which devices require. Older agents cannot update themselves
// into it and are told to run the install command again.
const MinAgentVersion = "3.0.0"

// MachinesScope is the scope an access token needs to register a machine;
// the IdP grants it to the tunelo-agent client only.
const MachinesScope = "machines:write"

// Limits and timings.
const (
	maxRequestBytes = 16 << 10
	// notifyWindow: at most one push per machine in this time.
	notifyWindow = 30 * time.Second
	// notifyTimeout bounds queueing a merged push after its window.
	notifyTimeout = 5 * time.Second
	// sweepAbove: past this many machines the ended windows are forgotten.
	sweepAbove   = 256
	maxPending   = 1000
	maxTunnelLen = 256
)

var (
	// limitAuthFailures is the failed-authentication budget of one address.
	limitAuthFailures = ratelimit.Rule{Rate: 0.2, Burst: 20}
	// limitMachineCalls bounds the authenticated calls of one machine
	// (heartbeats every 60 s, notices when a session waits).
	limitMachineCalls = ratelimit.Rule{Rate: 1, Burst: 30}
	// limitAccountCalls bounds GetMachineKeyChallenge and RegisterMachine of
	// one IdP account (tunelo retries them at most once a minute per
	// machine).
	limitAccountCalls = ratelimit.Rule{Rate: 0.2, Burst: 20}

	osNames   = map[string]bool{"darwin": true, "win32": true, "linux": true}
	archNames = map[string]bool{"arm64": true, "x64": true}

	// Base64url without padding of 32 bytes.
	secretRE    = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	sessionIDRE = regexp.MustCompile(`^[A-Za-z0-9_-]{0,64}$`)
	// providerIDRE: an agent's provider id; anything else is dropped, never refused.
	providerIDRE = regexp.MustCompile(`^[a-z0-9-]{1,32}$`)
	versionRE    = regexp.MustCompile(`^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})(-[0-9A-Za-z.-]{1,16})?$`)
)

// Notifier sends a machine's notice to its owner's devices (push.Service).
type Notifier interface {
	NotifyUser(ctx context.Context, userID int64, n push.MachineNotice) (int, error)
}

// TokenVerifier checks IdP access tokens offline (auth.IdP).
type TokenVerifier interface {
	VerifyAccessToken(ctx context.Context, raw, audience string) (auth.AccessToken, error)
}

// GrantRevoker revokes the IdP grants of removed machines
// (agentgrant.Revoker); Kick asks it to work now.
type GrantRevoker interface {
	Kick()
}

// Config holds the tenant settings.
type Config struct {
	TenantID string
	// TenantDomain is the tenant's domain: tunnel addresses must be
	// wss://<subdomain>.tunnel.<TenantDomain>.
	TenantDomain string
	// Resource is the audience the owner's access tokens must carry: the
	// chat's MCP resource, CHAT_PUBLIC_URL + "/mcp" (tunelo's one sign-in
	// asks the IdP for it).
	Resource string
	// AdmitNewUser takes a new-account token for the caller's address, as
	// a web sign-in does (auth.Routes.AdmitSignup); nil admits everyone.
	AdmitNewUser func(ip string) bool
	// KeyProofs makes and checks the machine key challenges.
	KeyProofs *keyproof.Issuer
	// Grants revokes the IdP grant of a machine that unregisters.
	Grants GrantRevoker
}

// Service is the handler of MachineAgentService.
type Service struct {
	appv1connect.UnimplementedMachineAgentServiceHandler
	cfg      Config
	store    *store.Store
	tokens   TokenVerifier
	notifier Notifier
	limiter  ratelimit.Limiter
	logger   *slog.Logger
	tunnelRE *regexp.Regexp
	now      func() time.Time
	// after runs f after d (time.AfterFunc; tests run it by hand).
	after func(d time.Duration, f func()) stopper

	mu      sync.Mutex
	notices map[int64]*noticeState
	closed  bool
}

// noticeState is the push window of one machine.
type noticeState struct {
	// sent is when the machine's last push went out.
	sent time.Time
	// next is the merged notice waiting for the window to end, sent by
	// timer.
	next  *push.MachineNotice
	timer stopper
}

// stopper is a pending timer.
type stopper interface{ Stop() bool }

// New returns the service; serve Handler at Prefix and Close it at shutdown.
func New(cfg Config, st *store.Store, tokens TokenVerifier, notifier Notifier, limiter ratelimit.Limiter, logger *slog.Logger) (*Service, error) {
	if st == nil || tokens == nil || notifier == nil || limiter == nil || logger == nil {
		return nil, errors.New("machineapi: missing dependency")
	}
	if cfg.TenantID == "" || cfg.TenantDomain == "" || cfg.Resource == "" || cfg.KeyProofs == nil || cfg.Grants == nil {
		return nil, errors.New("machineapi: incomplete configuration")
	}
	tunnelRE, err := regexp.Compile(`^wss://[a-z0-9-]+\.tunnel\.` + regexp.QuoteMeta(strings.ToLower(cfg.TenantDomain)) + `/?$`)
	if err != nil {
		return nil, fmt.Errorf("machineapi: tunnel pattern: %w", err)
	}
	return &Service{
		cfg: cfg, store: st, tokens: tokens, notifier: notifier, limiter: limiter, logger: logger, tunnelRE: tunnelRE, now: time.Now,
		after:   func(d time.Duration, f func()) stopper { return time.AfterFunc(d, f) },
		notices: map[int64]*noticeState{},
	}, nil
}

// Handler returns the Connect handler of the service, to mount at Prefix.
func (s *Service) Handler() http.Handler {
	path, h := appv1connect.NewMachineAgentServiceHandler(s,
		connect.WithInterceptors(idsInterceptor(s.logger)),
		connect.WithReadMaxBytes(maxRequestBytes))
	mux := http.NewServeMux()
	mux.Handle(path, h)
	return http.StripPrefix(strings.TrimSuffix(Prefix, "/"), mux)
}

// Close stops the pending merged pushes; later notices are dropped.
func (s *Service) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	for _, st := range s.notices {
		if st.timer != nil {
			st.timer.Stop()
		}
	}
	s.notices = map[int64]*noticeState{}
}

// ----------------------------------------------------------------- calls

func (s *Service) GetMachineKeyChallenge(ctx context.Context, req *connect.Request[appv1.GetMachineKeyChallengeRequest]) (*connect.Response[appv1.GetMachineKeyChallengeResponse], error) {
	if _, err := s.owner(ctx, req); err != nil {
		return nil, err
	}
	c, err := s.cfg.KeyProofs.Challenge(keyproof.Machine)
	if err != nil {
		return nil, s.internal(ctx, req.Spec().Procedure, err)
	}
	return connect.NewResponse(&appv1.GetMachineKeyChallengeResponse{Challenge: c}), nil
}

func (s *Service) RegisterMachine(ctx context.Context, req *connect.Request[appv1.RegisterMachineRequest]) (*connect.Response[appv1.RegisterMachineResponse], error) {
	tok, err := s.owner(ctx, req)
	if err != nil {
		return nil, err
	}
	m := req.Msg
	name, ok := store.CleanMachineName(m.GetName())
	if !ok {
		return nil, invalid("name must be 1 to 64 characters without control characters")
	}
	if !osNames[m.GetOs()] || !archNames[m.GetArch()] {
		return nil, invalid("os must be darwin, win32 or linux and arch arm64 or x64")
	}
	if err := checkVersion(m.GetAgentVersion()); err != nil {
		return nil, err
	}
	if len(m.GetPublicKey()) != store.MachineKeyLen {
		return nil, invalid("public_key must be 32 bytes")
	}
	if err := s.cfg.KeyProofs.Verify(keyproof.Machine, m.GetPublicKey(), m.GetProof()); err != nil {
		return nil, connect.NewError(connect.CodePermissionDenied,
			errors.New("bad_key_proof: the proof of the machine key does not check or its challenge expired; get a new challenge"))
	}
	// An account that never opened the chat gets its user now (not
	// findable until its first web sign-in), admitted as a web sign-up is.
	ip := auth.ClientIP(req.Peer().Addr, req.Header())
	user, err := s.store.UpsertPendingIdPUser(ctx, s.cfg.TenantID, tok.Subject, func() bool {
		return s.cfg.AdmitNewUser == nil || s.cfg.AdmitNewUser(ip)
	})
	if errors.Is(err, store.ErrSignupLimited) {
		return nil, errNoChatAccount()
	}
	if err != nil {
		return nil, s.internal(ctx, req.Spec().Procedure, err)
	}
	if tok.GrantID == "" {
		// The machine still registers; removing it cannot revoke its sign-in.
		s.logger.Warn("machine token names no grant", "user_id", user.ID, "client_id", tok.ClientID)
	}
	machine, secret, err := s.store.RegisterMachine(ctx, s.cfg.TenantID, user.ID, store.NewMachine{
		Name: name, OS: m.GetOs(), Arch: m.GetArch(), AgentVersion: m.GetAgentVersion(), PublicKey: m.GetPublicKey(),
		GrantID: tok.GrantID,
	})
	switch {
	case errors.Is(err, store.ErrNotFound):
		// An erased account, or erased in between.
		return nil, errNoChatAccount()
	case errors.Is(err, store.ErrTooManyMachines):
		return nil, connect.NewError(connect.CodeResourceExhausted,
			fmt.Errorf("too_many_machines: an account has at most %d machines; remove one first", store.MaxMachines))
	case err != nil:
		return nil, s.internal(ctx, req.Spec().Procedure, err)
	}
	s.logger.Info("machine registered", "machine_id", machine.ID, "user_id", machine.UserID, "os", machine.OS,
		"arch", machine.Arch, "agent_version", machine.AgentVersion, "client_id", tok.ClientID)
	return connect.NewResponse(&appv1.RegisterMachineResponse{MachineId: machine.ID, MachineSecret: secret}), nil
}

func (s *Service) UnregisterMachine(ctx context.Context, req *connect.Request[appv1.UnregisterMachineRequest]) (*connect.Response[appv1.UnregisterMachineResponse], error) {
	machine, err := s.authenticate(ctx, req)
	if err != nil {
		return nil, err
	}
	if !machine.Revoked {
		err := s.store.RevokeMachine(ctx, s.cfg.TenantID, machine.UserID, machine.ID)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			return nil, s.internal(ctx, req.Spec().Procedure, err)
		}
		s.logger.Info("machine unregistered itself", "machine_id", machine.ID, "user_id", machine.UserID)
	}
	s.cfg.Grants.Kick()
	return connect.NewResponse(&appv1.UnregisterMachineResponse{}), nil
}

func (s *Service) Heartbeat(ctx context.Context, req *connect.Request[appv1.HeartbeatRequest]) (*connect.Response[appv1.HeartbeatResponse], error) {
	machine, err := s.authenticate(ctx, req)
	if err != nil {
		return nil, err
	}
	if machine.Revoked {
		return connect.NewResponse(&appv1.HeartbeatResponse{Revoked: true, MinAgentVersion: MinAgentVersion}), nil
	}
	m := req.Msg
	if err := checkVersion(m.GetAgentVersion()); err != nil {
		return nil, err
	}
	tunnel := m.GetTunnelUrl()
	if tunnel != "" && (len(tunnel) > maxTunnelLen || !s.tunnelRE.MatchString(tunnel)) {
		return nil, invalid("tunnel_url must be wss://<subdomain>.tunnel." + strings.ToLower(s.cfg.TenantDomain))
	}
	tunnel = strings.TrimSuffix(tunnel, "/")
	// A tunnel of another account is never listed, but the machine stays
	// alive and still learns its trusted devices.
	refused := tunnel != "" && machine.Claimed && tunnel != s.machineTunnel(machine)
	if refused {
		s.logger.Warn("heartbeat with a tunnel of another account", "machine_id", machine.ID)
		tunnel = ""
	}
	connected := m.GetConnectedDeviceKeys()
	if len(connected) > store.MaxConnectedDeviceKeys {
		return nil, invalid(fmt.Sprintf("connected_device_keys holds at most %d keys", store.MaxConnectedDeviceKeys))
	}
	for _, k := range connected {
		if len(k) != store.MachineKeyLen {
			return nil, invalid("connected_device_keys must be 32 bytes each")
		}
	}
	devices, err := s.store.MachineHeartbeat(ctx, s.cfg.TenantID, machine.ID, tunnel, m.GetAgentVersion(), connected)
	if errors.Is(err, store.ErrNotFound) {
		// Revoked between authentication and the update.
		return connect.NewResponse(&appv1.HeartbeatResponse{Revoked: true, MinAgentVersion: MinAgentVersion}), nil
	}
	if err != nil {
		return nil, s.internal(ctx, req.Spec().Procedure, err)
	}
	trusted := make([]*appv1.TrustedDevice, len(devices))
	for i, d := range devices {
		trusted[i] = &appv1.TrustedDevice{PublicKey: d.PublicKey, Name: d.Name, Platform: d.Platform, CreatedAt: d.CreatedAt.Unix()}
	}
	return connect.NewResponse(&appv1.HeartbeatResponse{
		TrustedDevices: trusted, MinAgentVersion: MinAgentVersion, TunnelRefused: refused,
	}), nil
}

func (s *Service) NotifyNeedsInput(ctx context.Context, req *connect.Request[appv1.NotifyNeedsInputRequest]) (*connect.Response[appv1.NotifyNeedsInputResponse], error) {
	machine, err := s.authenticate(ctx, req)
	if err != nil {
		return nil, err
	}
	if machine.Revoked {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("machine_revoked: the machine was removed from the account"))
	}
	m := req.Msg
	var kind string
	switch m.GetKind() {
	case appv1.NeedsInputKind_NEEDS_INPUT_KIND_APPROVAL:
		kind = push.MachineApproval
	case appv1.NeedsInputKind_NEEDS_INPUT_KIND_QUESTION:
		kind = push.MachineQuestion
	case appv1.NeedsInputKind_NEEDS_INPUT_KIND_USAGE_HINT:
		if m.GetPendingCount() != 1 || m.GetSessionId() != "" {
			return nil, invalid("USAGE_HINT takes pending_count 1 and no session_id")
		}
		// Not a request waiting for the user: sent at once, apart from the
		// merged "needs you" pushes, so it neither delays nor replaces one.
		s.notifyNow(machine.UserID, push.MachineNotice{
			MachineID: machine.ID, MachineName: machine.Name, Kind: push.MachineUsageHint, Pending: 1,
		})
		return connect.NewResponse(&appv1.NotifyNeedsInputResponse{}), nil
	default:
		return nil, invalid("kind must be APPROVAL, QUESTION or USAGE_HINT")
	}
	if m.GetPendingCount() < 1 || m.GetPendingCount() > maxPending {
		return nil, invalid("pending_count must be 1 to 1000")
	}
	if !sessionIDRE.MatchString(m.GetSessionId()) {
		return nil, invalid("session_id must be up to 64 characters of A-Z, a-z, 0-9, _ and -")
	}
	provider := m.GetProviderId()
	if !providerIDRE.MatchString(provider) {
		provider = ""
	}
	s.notify(machine.UserID, push.MachineNotice{
		MachineID: machine.ID, MachineName: machine.Name, Kind: kind, Pending: int(m.GetPendingCount()),
		SessionID: m.GetSessionId(), Provider: provider,
	})
	return connect.NewResponse(&appv1.NotifyNeedsInputResponse{}), nil
}

// --------------------------------------------------------------- pushes

// notify sends n now when the machine's window is free, otherwise keeps it
// (replacing an earlier kept one) for the push at the window's end.
func (s *Service) notify(userID int64, n push.MachineNotice) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	now := s.now()
	st, ok := s.notices[n.MachineID]
	if !ok || now.Sub(st.sent) >= notifyWindow {
		if ok && st.timer != nil {
			// A merged push whose timer is late: this push replaces it.
			st.timer.Stop()
		}
		if len(s.notices) > sweepAbove {
			s.sweep(now)
		}
		s.notices[n.MachineID] = &noticeState{sent: now}
		s.mu.Unlock()
		s.send(context.Background(), userID, n)
		return
	}
	// Notices kept in one window that name different AIs push as "AI".
	if st.next != nil && st.next.Provider != n.Provider {
		n.Provider = ""
	}
	st.next = &n
	if st.timer == nil {
		st.timer = s.after(st.sent.Add(notifyWindow).Sub(now), func() { s.flush(userID, n.MachineID) })
	}
	s.mu.Unlock()
}

// notifyNow sends n at once, outside the machine's window.
func (s *Service) notifyNow(userID int64, n push.MachineNotice) {
	s.mu.Lock()
	closed := s.closed
	s.mu.Unlock()
	if !closed {
		s.send(context.Background(), userID, n)
	}
}

// flush sends the notice kept for the machine when its window ended.
func (s *Service) flush(userID, machineID int64) {
	s.mu.Lock()
	st, ok := s.notices[machineID]
	if !ok || s.closed || st.next == nil {
		s.mu.Unlock()
		return
	}
	n := *st.next
	st.next, st.timer, st.sent = nil, nil, s.now()
	s.mu.Unlock()
	s.send(context.Background(), userID, n)
}

// sweep forgets the windows that ended with nothing kept (under mu).
func (s *Service) sweep(now time.Time) {
	for id, st := range s.notices {
		if st.timer == nil && now.Sub(st.sent) >= notifyWindow {
			delete(s.notices, id)
		}
	}
}

func (s *Service) send(ctx context.Context, userID int64, n push.MachineNotice) {
	ctx, cancel := context.WithTimeout(ctx, notifyTimeout)
	defer cancel()
	n.At = s.now()
	if _, err := s.notifier.NotifyUser(ctx, userID, n); err != nil {
		s.logger.Warn("machine push failed", "machine_id", n.MachineID, "err", err)
	}
}

// ------------------------------------------------------------- helpers

// authenticate resolves the machine of the bearer secret, revoked or not,
// and applies its call budget.
func (s *Service) authenticate(ctx context.Context, req connect.AnyRequest) (store.AuthenticatedMachine, error) {
	secret, ok := bearer(req.Header().Get("Authorization"))
	if !ok || !secretRE.MatchString(secret) {
		return store.AuthenticatedMachine{}, s.authFailed(req, "missing or invalid machine secret (Authorization: Bearer <machine_secret>)")
	}
	machine, err := s.store.AuthenticateMachine(ctx, s.cfg.TenantID, secret)
	if errors.Is(err, store.ErrNotFound) {
		return store.AuthenticatedMachine{}, s.authFailed(req, "missing or invalid machine secret (Authorization: Bearer <machine_secret>)")
	}
	if err != nil {
		return store.AuthenticatedMachine{}, s.internal(ctx, req.Spec().Procedure, err)
	}
	if !s.limiter.Allow(limitMachineCalls, "machinecall:"+strconv.FormatInt(machine.ID, 10)) {
		return store.AuthenticatedMachine{}, connect.NewError(connect.CodeResourceExhausted, errors.New("rate_limited: too many calls; retry later"))
	}
	return machine, nil
}

// owner verifies the access token of the machine's owner (the bearer of
// GetMachineKeyChallenge and RegisterMachine): an IdP access token of the
// chat's resource carrying MachinesScope. It applies the account's call
// budget.
func (s *Service) owner(ctx context.Context, req connect.AnyRequest) (auth.AccessToken, error) {
	raw, ok := bearer(req.Header().Get("Authorization"))
	if !ok {
		return auth.AccessToken{}, s.authFailed(req, "invalid_token: send the account's access token (Authorization: Bearer <token>); run tunelo login")
	}
	tok, err := s.tokens.VerifyAccessToken(ctx, raw, s.cfg.Resource)
	if errors.Is(err, auth.ErrIdPUnavailable) {
		return auth.AccessToken{}, connect.NewError(connect.CodeUnavailable, errors.New("auth_unavailable: sign-in is not available yet; retry shortly"))
	}
	if err != nil {
		s.logger.Debug("machine owner token rejected", "err", err)
		return auth.AccessToken{}, s.authFailed(req, "invalid_token: the access token is invalid or expired; run tunelo login")
	}
	if !tok.HasScope(MachinesScope) {
		return auth.AccessToken{}, connect.NewError(connect.CodePermissionDenied,
			fmt.Errorf("insufficient_scope: the token lacks %s; update tunelo and run tunelo login", MachinesScope))
	}
	if !s.limiter.Allow(limitAccountCalls, "machineowner:"+tok.Subject) {
		return auth.AccessToken{}, connect.NewError(connect.CodeResourceExhausted, errors.New("rate_limited: too many calls; retry later"))
	}
	return tok, nil
}

// machineTunnel is the only tunnel address a machine may report.
func (s *Service) machineTunnel(m store.AuthenticatedMachine) string {
	return "wss://" + MachineSubdomain(m.OwnerSub, machineDeviceID(m.ID)) + ".tunnel." + strings.ToLower(s.cfg.TenantDomain)
}

func errNoChatAccount() error {
	return connect.NewError(connect.CodeFailedPrecondition,
		errors.New("chat_account_missing: the chat cannot add this account yet; open the chat once, or wait, and the machine is added by itself"))
}

// authFailed counts a failed authentication of the caller's address: within
// the budget it answers unauthenticated with msg, beyond it
// resource_exhausted.
func (s *Service) authFailed(req connect.AnyRequest, msg string) error {
	ip := auth.ClientIP(req.Peer().Addr, req.Header())
	if !s.limiter.Allow(limitAuthFailures, "machineauth:"+ip) {
		return connect.NewError(connect.CodeResourceExhausted, errors.New("rate_limited: too many failed authentications; retry later"))
	}
	return connect.NewError(connect.CodeUnauthenticated, errors.New(msg))
}

func (s *Service) internal(ctx context.Context, procedure string, err error) error {
	if ctx.Err() != nil {
		return connect.NewError(connect.CodeCanceled, ctx.Err())
	}
	s.logger.Error("machine api call failed", "procedure", procedure, "err", err)
	return connect.NewError(connect.CodeInternal, errors.New("internal error"))
}

func invalid(msg string) error {
	return connect.NewError(connect.CodeInvalidArgument, errors.New(msg))
}

func bearer(header string) (string, bool) {
	scheme, token, ok := strings.Cut(header, " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return "", false
	}
	token = strings.TrimSpace(token)
	return token, token != ""
}

// checkVersion accepts a semantic version at or above MinAgentVersion
// (a pre-release counts as its release).
func checkVersion(v string) error {
	got, ok := parseVersion(v)
	if !ok {
		return invalid("agent_version must be a semantic version such as 3.0.0")
	}
	minimum, _ := parseVersion(MinAgentVersion)
	for i := range got {
		if got[i] != minimum[i] {
			if got[i] < minimum[i] {
				return connect.NewError(connect.CodeFailedPrecondition,
					fmt.Errorf("agent_update_required: tunelo %s or newer is required; run the install command on the chat's Machines page again", MinAgentVersion))
			}
			return nil
		}
	}
	return nil
}

func parseVersion(v string) ([3]int, bool) {
	var out [3]int
	m := versionRE.FindStringSubmatch(v)
	if m == nil {
		return out, false
	}
	for i := range out {
		n, err := strconv.Atoi(m[i+1])
		if err != nil {
			return out, false
		}
		out[i] = n
	}
	return out, true
}

// idsInterceptor enforces the JS safe-integer contract (ADR 0001) on the
// answers, as /rpc does.
func idsInterceptor(logger *slog.Logger) connect.UnaryInterceptorFunc {
	return func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
			resp, err := next(ctx, req)
			if err != nil || resp == nil {
				return resp, err
			}
			if msg, ok := resp.Any().(proto.Message); ok {
				if err := protoids.Check(msg); err != nil {
					logger.Error("response violates the id contract", "procedure", req.Spec().Procedure, "err", err)
					return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
				}
			}
			return resp, nil
		}
	}
}
