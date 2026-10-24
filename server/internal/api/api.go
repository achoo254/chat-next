// Package api assembles the HTTP server of the api role: /healthz, the web
// sign-in routes under /auth, the Connect services under /rpc, the
// realtime WebSocket at /ws (the gateway runs inside the api process in
// stage 1), the incoming webhook endpoint POST /hook/... (in the same
// process, so a hook message reaches the in-memory gateway right after
// commit), the Bot API under /bot/v1/ and, on the media host only, media downloads and proxied upload
// parts.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/netip"
	"os/signal"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	"app.local/server/internal/assistant"
	"app.local/server/internal/auth"
	"app.local/server/internal/botadmin"
	"app.local/server/internal/botapi"
	"app.local/server/internal/botbulk"
	"app.local/server/internal/botupdates"
	"app.local/server/internal/brand"
	"app.local/server/internal/chat"
	"app.local/server/internal/config"
	"app.local/server/internal/gateway"
	"app.local/server/internal/hooks"
	"app.local/server/internal/linkpreview"
	"app.local/server/internal/media"
	"app.local/server/internal/miniapp"
	"app.local/server/internal/privacy"
	"app.local/server/internal/push"
	"app.local/server/internal/ratelimit"
	"app.local/server/internal/rpc"
	"app.local/server/internal/safehttp"
	"app.local/server/internal/store"
	"app.local/server/internal/watch"
	"app.local/server/internal/webpush"
)

const (
	healthTimeout   = 2 * time.Second
	shutdownTimeout = 20 * time.Second
	// socketsTimeout bounds closing the realtime sockets at shutdown.
	socketsTimeout = 5 * time.Second
)

// App is the wired api role.
type App struct {
	Handler  http.Handler
	IdP      *auth.IdP
	Sessions *auth.Sessions
	Chat     *chat.Service
	Hooks    *hooks.Service
	// Media is nil when no storage is configured.
	Media *media.Service
	Hub   *gateway.Hub
	// BotAdmin manages bots; BotUpdates feeds the Bot API's getUpdates.
	BotAdmin   *botadmin.Service
	BotUpdates *botupdates.Service
	// Assistant is the tenant's official bot; nil when it could not be set
	// up (its username belongs to someone else).
	Assistant *assistant.Service
	// Push holds Web Push registrations and sends pushes (off without a
	// VAPID key).
	Push *push.Service
	// Privacy builds data exports and deletes accounts.
	Privacy *privacy.Service

	logger   *slog.Logger
	cancel   context.CancelFunc
	loops    sync.WaitGroup
	shutdown sync.Once
}

// Options adjust New for tests.
type Options struct {
	// LinkPreviewAllow replaces the public-address policy of the link
	// preview fetcher (tests reach a local page with it).
	LinkPreviewAllow func(netip.AddrPort) bool
	// MediaObjects replaces the S3 client (tests use an in-process fake).
	MediaObjects media.Objects
}

// New wires the api role on an open store and starts its background loops
// (Snowflake lease, outbox sweeper, maintenance, chat activity hints); stop
// them with Shutdown. The IdP is not discovered yet: call IdP.RunDiscovery
// (or IdP.Discover) before sign-in can work.
func New(ctx context.Context, cfg config.Config, st *store.Store, httpClient *http.Client, logger *slog.Logger, opts Options) (*App, error) {
	publicOrigin := cfg.PublicOrigin()
	idp := auth.NewIdP(auth.IdPConfig{
		Issuer:       cfg.OIDCIssuer,
		ClientID:     cfg.OIDCClientID,
		ClientSecret: cfg.OIDCClientSecret,
		RedirectURL:  publicOrigin + "/auth/callback",
		// One app for every tenant: its scheme is the brand's (ADR 0006).
		MobileRedirectURL: cfg.MobileRedirectURL(),
		HTTPClient:        httpClient,
		Logger:            logger,
	})
	sessions, err := auth.NewSessions(st, idp, cfg.SessionKey, cfg.SessionKeyPrevious, cfg.TenantID, logger)
	if err != nil {
		return nil, err
	}
	origins := auth.NewOrigins(publicOrigin, cfg.DevOrigins...)
	limiter := ratelimit.NewMemory()
	routes, err := auth.NewRoutes(auth.RoutesConfig{
		IdP: idp, Sessions: sessions, Store: st, Origins: origins,
		TenantID: cfg.TenantID, PublicOrigin: publicOrigin, SessionKey: cfg.SessionKey,
		SessionKeyPrevious: cfg.SessionKeyPrevious, Logger: logger,
		Limiter: limiter, SignupsPerIPHour: cfg.Abuse.SignupsPerIPHour, SignupsPer10Min: cfg.Abuse.SignupsPer10Min,
	})
	if err != nil {
		return nil, err
	}
	ids, err := chat.LeaseIDs(ctx, st, logger)
	if err != nil {
		return nil, err
	}
	deny := outboundDeny(cfg, logger)
	previewAllow := opts.LinkPreviewAllow
	if previewAllow == nil {
		previewAllow = func(ap netip.AddrPort) bool {
			return linkpreview.PublicAddress(ap) && !safehttp.Denied(deny, ap.Addr())
		}
	}
	previews := linkpreview.NewService(st.Pool(), linkpreview.NewFetcher(linkpreview.Options{Allow: previewAllow}), logger)
	mediaSvc, err := newMedia(cfg, st, limiter, logger, opts.MediaObjects)
	if err != nil {
		return nil, err
	}
	chatSvc, err := chat.New(chat.Config{
		TenantID: cfg.TenantID, PublicOrigin: publicOrigin, AppScheme: cfg.AppURLScheme, Operators: cfg.OperatorUserIDs,
		Abuse: chat.AbuseLimits{
			StrangerChatsNew: cfg.Abuse.StrangerChatsNew, StrangerChats: cfg.Abuse.StrangerChats,
			NewAccountAge: time.Duration(cfg.Abuse.NewAccountDays) * 24 * time.Hour, Reporters: cfg.Abuse.Reporters,
		},
	}, chat.Deps{Pool: st.Pool(), IDs: ids, Previews: previews, Media: mediaSvc, Limiter: limiter, Logger: logger})
	if err != nil {
		return nil, err
	}
	if mediaSvc != nil {
		mediaSvc.SetRefresher(chatSvc)
	}
	hub := gateway.NewHub(chatSvc, logger)
	hub.SetMaxOnlineUsers(cfg.MaxOnlineUsers)
	chatSvc.SetRealtime(hub, hub)
	ws, err := gateway.New(gateway.Config{Hub: hub, Sessions: sessions, Toucher: st, Origins: origins, Logger: logger})
	if err != nil {
		return nil, err
	}
	hookSvc, err := hooks.New(hooks.Config{TenantID: cfg.TenantID, PublicOrigin: publicOrigin, AppScheme: cfg.AppURLScheme},
		st.Pool(), chatSvc, limiter, logger)
	if err != nil {
		return nil, err
	}
	miniAppURLs, err := miniapp.NewURLs(publicOrigin)
	if err != nil {
		return nil, err
	}
	miniAppSigner, err := miniapp.NewSigner(cfg.SessionKey, cfg.TenantID)
	if err != nil {
		return nil, err
	}
	botAdmin, err := botadmin.New(st.Pool(), cfg.TenantID, miniAppURLs, limiter, logger)
	if err != nil {
		return nil, err
	}
	botUpdates, err := botupdates.New(st.Pool(), chatSvc, cfg.AppURLScheme, logger.With("component", "botupdates"))
	if err != nil {
		return nil, err
	}
	pushSvc, err := newPush(cfg, st, chatSvc, hub, logger)
	if err != nil {
		return nil, err
	}
	chatSvc.SetCommitObserver(func() {
		botUpdates.Kick()
		pushSvc.Kick()
	})
	botAPI, err := botapi.New(botapi.Config{TenantID: cfg.TenantID, PublicOrigin: publicOrigin, AppScheme: cfg.AppURLScheme,
		MiniAppKey: miniAppSigner.PublicKey()},
		chatSvc, botAdmin, botUpdates, limiter, logger.With("component", "botapi"))
	if err != nil {
		return nil, err
	}
	if mediaSvc != nil {
		botAPI.UseMedia(mediaSvc)
	}
	botAPI.UseTyper(hub)
	bulk := botbulk.New(st.Pool(), chatSvc, cfg.TenantID, logger.With("component", "botbulk"))
	botAPI.UseBulk(bulk)
	// Webhooks of bots: outbound requests through safehttp; actions in their
	// answers run through the Bot API's own checks.
	if err := botUpdates.EnableWebhooks(botupdates.WebhookOptions{
		TenantID: cfg.TenantID, SessionKey: cfg.SessionKey, SessionKeyPrevious: cfg.SessionKeyPrevious, Local: cfg.BotWebhookLocal, Reply: botAPI.WebhookReply, Deny: deny,
	}); err != nil {
		return nil, err
	}
	assistantSvc, err := newAssistant(ctx, chatSvc, botAdmin, botUpdates, botAPI, logger)
	if err != nil {
		return nil, err
	}
	if assistantSvc != nil {
		assistantSvc.UseBulk(bulk)
	}
	privacySvc, err := newPrivacy(cfg, st, chatSvc, sessions, botAdmin, mediaSvc, logger)
	if err != nil {
		return nil, err
	}
	var feedback rpc.FeedbackReplier
	var announcer rpc.Announcer
	if assistantSvc != nil {
		feedback, announcer = assistantSvc, assistantSvc
		chatSvc.SetNotifier(assistantSvc)
	}
	rpcHandler, err := rpc.NewHandler(rpc.Deps{
		Store: st, IdP: idp, Sessions: sessions, Origins: origins, SignIn: routes, Chat: chatSvc, Hooks: hookSvc, Media: mediaSvc,
		Bots: botAdmin, BotUpdates: botUpdates, MiniApp: miniAppSigner, Push: pushSvc, Privacy: privacySvc, Feedback: feedback, Announcer: announcer, TenantID: cfg.TenantID,
		TenantName: cfg.TenantDomain, Logger: logger,
	})
	if err != nil {
		return nil, err
	}
	if err := chatSvc.Start(ctx); err != nil {
		return nil, err
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", healthz(st))
	routes.Register(mux)
	// The native app calls /rpc cross-origin from its WebView (ADR 0011).
	mux.Handle("/rpc/", auth.NativeCORS(origins, http.StripPrefix("/rpc", rpcHandler)))
	mux.Handle("GET /ws", ws)
	for _, route := range hooks.Routes {
		mux.Handle(route, hookSvc)
	}
	mux.Handle(botapi.Prefix, botAPI)

	loopCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	app := &App{Handler: mux, IdP: idp, Sessions: sessions, Chat: chatSvc, Hooks: hookSvc, Media: mediaSvc, Hub: hub,
		BotAdmin: botAdmin, BotUpdates: botUpdates, Assistant: assistantSvc, Push: pushSvc, Privacy: privacySvc, logger: logger,
		cancel: cancel}
	loops := []func(context.Context){
		ids.Run, chatSvc.RunOutboxSweeper, chatSvc.RunMaintenance, hub.RunActivity, ws.RunSweeps, hookSvc.Run, botUpdates.Run,
		pushSvc.Run, privacySvc.Run,
		func(ctx context.Context) { runEvery(ctx, time.Minute, func() { limiter.Sweep(10 * time.Minute) }) },
		func(ctx context.Context) {
			runEvery(ctx, botAbuseRuleEvery, func() {
				if err := chatSvc.ApplyBotAbuseRule(ctx); err != nil && ctx.Err() == nil {
					logger.Warn("bot anti-abuse rule failed", "err", err)
				}
			})
		},
	}
	opsGroup := watch.NewGroup(watch.GroupConfig{
		TenantID: cfg.TenantID, Operators: cfg.OperatorUserIDs, Pool: st.Pool(), Chats: chatSvc, Hooks: hookSvc,
		Logger: logger.With("component", "watch"),
	})
	chatSvc.SetOpsSignals(watch.NewSignals(opsGroup, publicOrigin))
	digest := watch.NewDigest(watch.DigestConfig{TenantID: cfg.TenantID, Pool: st.Pool(), Group: opsGroup, Logger: logger.With("component", "watch")})
	loops = append(loops, bulk.Run, newWatcher(cfg, st, chatSvc, hookSvc, opsGroup, logger).Run, digest.Run)
	if assistantSvc != nil {
		loops = append(loops, assistantSvc.Run)
	}
	if mediaSvc != nil {
		app.Handler = byHost(cfg.Media.PublicURL.Host, withExportDownloads(privacySvc, mediaSvc.Handler()), mux)
		loops = append(loops, mediaSvc.RunLifecycle, mediaSvc.RunWorker)
	}
	for _, loop := range loops {
		app.loops.Add(1)
		go func() {
			defer app.loops.Done()
			loop(loopCtx)
		}()
	}
	return app, nil
}

// Production layout of the shared server (infra/chat): the watchdog checks
// these when they exist.
const (
	backupDir = "/opt/chat/backups"
	// nginx, which serves the certificate.
	originTLS = "127.0.0.1:443"
)

// newWatcher sets up the watchdog: problems of the service (outbox, log
// errors, certificate) and of the machine (memory, disk, backups).
func newWatcher(cfg config.Config, st *store.Store, chatSvc *chat.Service, hookSvc *hooks.Service, group *watch.Group, logger *slog.Logger) *watch.Watcher {
	checks := []watch.Check{watch.Outbox(st.Pool(), cfg.TenantID, []string{botupdates.CursorName, push.CursorName}, time.Now), watch.Errors(watch.Process)}
	if cfg.PublicURL != nil && cfg.PublicURL.Scheme == "https" {
		checks = append(checks, watch.Cert(cfg.PublicURL.Hostname(), originTLS, time.Now))
	}
	disks := []string{"/"}
	if cfg.Media != nil && cfg.Media.Root != "" {
		disks = append(disks, cfg.Media.Root)
	}
	checks = append(checks, watch.Memory(), watch.Disk(disks...), watch.Backup(backupDir, time.Now))
	return watch.New(watch.Config{
		TenantID: cfg.TenantID, Operators: cfg.OperatorUserIDs, Pool: st.Pool(),
		Chats: chatSvc, Hooks: hookSvc, Checks: checks, Logger: logger.With("component", "watch"), Group: group,
	})
}

// newPush sets up Web Push: off (registrations refused, no consumer)
// without WEB_PUSH_VAPID_PRIVATE_KEY.
func newPush(cfg config.Config, st *store.Store, chatSvc *chat.Service, hub *gateway.Hub, logger *slog.Logger) (*push.Service, error) {
	names, err := brand.Load()
	if err != nil {
		return nil, err
	}
	var sender *webpush.Sender
	if wp := cfg.WebPush; wp != nil {
		vapid, err := webpush.NewVAPID(wp.VAPIDKey, wp.Subject)
		if err != nil {
			return nil, err
		}
		if sender, err = webpush.NewSender(vapid, webpush.SenderOptions{AllowLocal: wp.AllowLocal, PadTo: push.PadTo}); err != nil {
			return nil, err
		}
	}
	logger.Info("web push", "enabled", sender != nil)
	return push.New(st.Pool(), chatSvc, hub, push.Config{
		TenantID: cfg.TenantID, AppName: names.PushSenderName, Sender: sender,
		SessionIdleTimeout: store.SessionIdleTimeout, SessionMaxAge: store.SessionMaxAge,
	}, logger.With("component", "push"))
}

// newPrivacy sets up data exports and account deletion. Exports need the
// media host (downloads) and an export directory (by default under the
// filesystem media root); without them only deletion works.
func newPrivacy(cfg config.Config, st *store.Store, chatSvc *chat.Service, sessions *auth.Sessions, bots *botadmin.Service,
	mediaSvc *media.Service, logger *slog.Logger) (*privacy.Service, error) {
	pc := privacy.Config{TenantID: cfg.TenantID, SessionKey: cfg.SessionKey, SessionKeyPrevious: cfg.SessionKeyPrevious}
	deps := privacy.Deps{Pool: st.Pool(), Chat: chatSvc, Sessions: sessions, Bots: bots, Logger: logger.With("component", "privacy")}
	if m := cfg.Media; m != nil && mediaSvc != nil {
		pc.ExportDir, pc.MediaOrigin, pc.MinFreeBytes = m.ExportDir, m.PublicOrigin(), m.MinFreeBytes
		deps.Media = mediaSvc
	}
	svc, err := privacy.New(pc, deps)
	if err != nil {
		return nil, err
	}
	logger.Info("data exports", "enabled", svc.ExportsEnabled())
	return svc, nil
}

// withExportDownloads serves the data export downloads (privacy.
// DownloadPrefix) on the media host in front of the media handler.
func withExportDownloads(p *privacy.Service, media http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, privacy.DownloadPrefix) {
			p.ServeDownload(w, r)
			return
		}
		media.ServeHTTP(w, r)
	})
}

// newAssistant sets up the tenant's assistant bot. When another account
// holds its username the app runs without it (logged as an error for the
// operators); any other failure stops the start like other database errors.
func newAssistant(ctx context.Context, chatSvc *chat.Service, admin *botadmin.Service, updates *botupdates.Service,
	botAPI *botapi.Service, logger *slog.Logger) (*assistant.Service, error) {
	names, err := brand.Load()
	if err != nil {
		return nil, err
	}
	svc, err := assistant.New(chatSvc, admin, updates, botAPI, names, logger.With("component", "assistant"))
	if err != nil {
		return nil, err
	}
	err = svc.Ensure(ctx)
	if errors.Is(err, botadmin.ErrSystemUsernameTaken) {
		logger.Error("assistant bot is off: another account holds its username; rename that account and restart",
			"username", assistant.Username)
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("api: assistant bot: %w", err)
	}
	logger.Info("assistant bot ready", "bot_id", svc.BotID(), "username", assistant.Username)
	return svc, nil
}

// outboundDeny is what URLs chosen by users and bots (webhooks, link
// previews) may not reach: OUTBOUND_DENY_CIDRS and the public addresses of
// this host's interfaces. A failure to list the interfaces is logged, not
// fatal: the configured list still applies.
func outboundDeny(cfg config.Config, logger *slog.Logger) []netip.Prefix {
	deny := append([]netip.Prefix(nil), cfg.OutboundDeny...)
	host, err := safehttp.HostAddresses()
	if err != nil {
		logger.Warn("listing this host's addresses failed; only OUTBOUND_DENY_CIDRS is refused", "err", err)
	}
	for _, p := range host {
		// OUTBOUND_DENY_CIDRS often names this host already.
		if !slices.Contains(deny, p) {
			deny = append(deny, p)
		}
	}
	ranges := make([]string, len(deny))
	for i, p := range deny {
		ranges[i] = p.String()
	}
	logger.Info("outbound requests refuse these ranges", "configured", len(cfg.OutboundDeny), "ranges", ranges)
	return deny
}

// newMedia builds the media service when storage is configured.
func newMedia(cfg config.Config, st *store.Store, limiter ratelimit.Limiter, logger *slog.Logger, objects media.Objects) (*media.Service, error) {
	m := cfg.Media
	if m == nil {
		return nil, nil
	}
	if objects == nil {
		var err error
		switch m.Storage {
		case config.StorageS3:
			objects, err = media.NewS3(media.S3Config{
				Endpoint: m.Endpoint, PublicEndpoint: m.PublicEndpoint, Region: m.Region, Bucket: m.Bucket,
				AccessKey: m.AccessKey, SecretKey: m.SecretKey, PathStyle: m.PathStyle, Prefix: m.Prefix,
			})
		default:
			objects, err = media.NewFilesystem(m.Root)
		}
		if err != nil {
			return nil, err
		}
	}
	return media.New(media.Config{
		TenantID: cfg.TenantID, PublicOrigin: m.PublicOrigin(), UploadMaxBytes: m.UploadMaxBytes,
		UserQuotaBytes: m.UserQuotaBytes, UploadMode: m.UploadMode, FFmpegPath: m.FFmpegPath, SessionKey: cfg.SessionKey,
		SessionKeyPrevious: cfg.SessionKeyPrevious, MinFreeBytes: m.MinFreeBytes,
	}, st.Pool(), objects, limiter, logger.With("component", "media"))
}

// byHost sends requests for the media host to the media handler and
// everything else to the app: no app route (cookies, RPC) answers on the
// media host, and no media route on the app's hosts.
func byHost(mediaHost string, mediaHandler, app http.Handler) http.Handler {
	mediaHost = strings.ToLower(mediaHost)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.EqualFold(r.Host, mediaHost) {
			mediaHandler.ServeHTTP(w, r)
			return
		}
		app.ServeHTTP(w, r)
	})
}

// botAbuseRuleEvery is how often the bot anti-abuse rule runs.
const botAbuseRuleEvery = 10 * time.Minute

func runEvery(ctx context.Context, every time.Duration, fn func()) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			fn()
		}
	}
}

// Shutdown closes the realtime sockets (asking clients to reconnect), stops
// the background loops, drains queued deliveries and background IdP work.
// Call it after the HTTP server stopped accepting requests and before the
// store is closed.
func (a *App) Shutdown() {
	a.shutdown.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), socketsTimeout)
		a.Hub.Shutdown(ctx)
		cancel()
		a.cancel()
		a.loops.Wait()
		a.Chat.Stop()
		// After the dispatcher drained: its realtime counts are in memory.
		flushCtx, cancelFlush := context.WithTimeout(context.Background(), socketsTimeout)
		if err := a.Hooks.Flush(flushCtx); err != nil {
			a.logger.Warn("hook counters lost at shutdown", "err", err)
		}
		cancelFlush()
		a.Sessions.Wait()
	})
}

// healthz answers {"status":"ok","db":"connected"}, or 503 when the
// database does not answer.
func healthz(st *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), healthTimeout)
		defer cancel()
		status, body := http.StatusOK, map[string]string{"status": "ok", "db": "connected"}
		if err := st.Ping(ctx); err != nil {
			status, body = http.StatusServiceUnavailable, map[string]string{"status": "error", "db": "unreachable"}
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
	}
}

// Run serves the api role until SIGINT or SIGTERM, then drains requests and
// background IdP work.
func Run(ctx context.Context, cfg config.Config, logger *slog.Logger) error {
	return RunWrapped(ctx, cfg, logger, nil)
}

// RunWrapped is Run with the app's handler passed through wrap (nil leaves
// it as is); wrap also gets the app. The local end-to-end stack uses it to
// cut realtime sockets and switch the assistant on demand; production runs
// plain Run.
func RunWrapped(ctx context.Context, cfg config.Config, logger *slog.Logger, wrap func(*App, http.Handler) http.Handler) error {
	ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	st, err := store.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer st.Close()
	if err := st.EnsureTenant(ctx, cfg.TenantID, cfg.TenantDomain, cfg.TenantDomain); err != nil {
		return err
	}
	app, err := New(ctx, cfg, st, nil, logger, Options{})
	if err != nil {
		return err
	}
	go app.IdP.RunDiscovery(ctx)

	handler := app.Handler
	if wrap != nil {
		handler = wrap(app, handler)
	}
	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelWarn),
	}
	// Long polls of the Bot API end at once on shutdown instead of holding
	// the drain for up to 50 seconds.
	srv.RegisterOnShutdown(app.BotUpdates.ReleasePolls)
	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.ListenAndServe() }()
	logger.Info("api listening", "addr", cfg.ListenAddr, "public_origin", cfg.PublicOrigin(), "env", cfg.Env,
		"operators", len(cfg.OperatorUserIDs))

	select {
	case err := <-serveErr:
		return fmt.Errorf("api: serve: %w", err)
	case <-ctx.Done():
	}
	logger.Info("api shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	err = srv.Shutdown(shutdownCtx)
	app.Shutdown()
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("api: shutdown: %w", err)
	}
	return nil
}
