// Package api assembles the HTTP server of the api role: /healthz, the web
// sign-in routes under /auth and the Connect services under /rpc.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"app.local/server/internal/auth"
	"app.local/server/internal/config"
	"app.local/server/internal/rpc"
	"app.local/server/internal/store"
)

const (
	healthTimeout   = 2 * time.Second
	shutdownTimeout = 20 * time.Second
)

// App is the wired api role.
type App struct {
	Handler  http.Handler
	IdP      *auth.IdP
	Sessions *auth.Sessions
}

// New wires the api role on an open store. The IdP is not discovered yet:
// call IdP.RunDiscovery (or IdP.Discover) before sign-in can work.
func New(cfg config.Config, st *store.Store, httpClient *http.Client, logger *slog.Logger) (*App, error) {
	publicOrigin := cfg.PublicOrigin()
	idp := auth.NewIdP(auth.IdPConfig{
		Issuer:       cfg.OIDCIssuer,
		ClientID:     cfg.OIDCClientID,
		ClientSecret: cfg.OIDCClientSecret,
		RedirectURL:  publicOrigin + "/auth/callback",
		HTTPClient:   httpClient,
		Logger:       logger,
	})
	sessions, err := auth.NewSessions(st, idp, cfg.SessionKey, cfg.TenantID, logger)
	if err != nil {
		return nil, err
	}
	origins := auth.NewOrigins(publicOrigin, cfg.DevOrigins...)
	routes, err := auth.NewRoutes(auth.RoutesConfig{
		IdP: idp, Sessions: sessions, Store: st, Origins: origins,
		TenantID: cfg.TenantID, PublicOrigin: publicOrigin, SessionKey: cfg.SessionKey, Logger: logger,
	})
	if err != nil {
		return nil, err
	}
	rpcHandler, err := rpc.NewHandler(rpc.Deps{
		Store: st, IdP: idp, Sessions: sessions, Origins: origins,
		TenantID: cfg.TenantID, TenantName: cfg.TenantDomain, Logger: logger,
	})
	if err != nil {
		return nil, err
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", healthz(st))
	routes.Register(mux)
	mux.Handle("/rpc/", http.StripPrefix("/rpc", rpcHandler))
	return &App{Handler: mux, IdP: idp, Sessions: sessions}, nil
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
	app, err := New(cfg, st, nil, logger)
	if err != nil {
		return err
	}
	go app.IdP.RunDiscovery(ctx)

	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           app.Handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelWarn),
	}
	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.ListenAndServe() }()
	logger.Info("api listening", "addr", cfg.ListenAddr, "public_origin", cfg.PublicOrigin(), "env", cfg.Env)

	select {
	case err := <-serveErr:
		return fmt.Errorf("api: serve: %w", err)
	case <-ctx.Done():
	}
	logger.Info("api shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	err = srv.Shutdown(shutdownCtx)
	app.Sessions.Wait()
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("api: shutdown: %w", err)
	}
	return nil
}
