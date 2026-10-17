package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	_ "net/http/pprof"
	"os"
	"os/signal"
	"syscall"
	"time"

	"app.local/server/internal/api"
	"app.local/server/internal/auth/idptest"
	"app.local/server/internal/config"
	"app.local/server/internal/store/testdb"
)

const clientID = "chat-web"

// accountSub is the IdP subject of fake person i (1-based); run signs in
// with the same names.
func accountSub(i int) string { return fmt.Sprintf("acc_load%04d", i) }

func accounts(n int) []idptest.Account {
	out := make([]idptest.Account, n)
	for i := range out {
		name := fmt.Sprintf("load%04d", i+1)
		out[i] = idptest.Account{
			Sub: accountSub(i + 1), SID: "sid-" + name, PreferredUsername: name, Name: "Tải " + name[4:],
			Email: name + "@load.test", EmailVerified: true,
		}
	}
	return out
}

func randomBase64(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// stackMain runs the whole backend for a load run on this machine.
func stackMain(args []string) int {
	flags := flag.NewFlagSet("stack", flag.ContinueOnError)
	apiAddr := flags.String("api", "127.0.0.1:4700", "api listen address")
	idpAddr := flags.String("idp", "127.0.0.1:4710", "fake IdP listen address")
	pgPort := flags.Uint("pg-port", 4730, "PostgreSQL port on 127.0.0.1")
	n := flags.Int("accounts", 2000, "fake people offered by the IdP")
	pprofAddr := flags.String("pprof", "127.0.0.1:4720", "net/http/pprof of the api process (empty: off)")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *pprofAddr != "" {
		// The default mux holds the pprof handlers (imported below).
		go func() { _ = http.ListenAndServe(*pprofAddr, nil) }() //nolint:gosec // loopback profiling of a load-test process
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := stack(ctx, *apiAddr, *idpAddr, uint32(*pgPort), *n, logger); err != nil {
		fmt.Fprintln(os.Stderr, "loadgen stack:", err)
		return 1
	}
	return 0
}

func stack(ctx context.Context, apiAddr, idpAddr string, pgPort uint32, n int, logger *slog.Logger) error {
	dir, err := os.MkdirTemp("", "chat-load-")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(dir) }()
	pg, err := testdb.Start(dir, pgPort)
	if err != nil {
		return err
	}
	defer func() { _ = pg.Stop() }()
	dbURL, err := pg.CreateMigrated(ctx, "chat", logger)
	if err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	secret := randomBase64(24)
	idp, err := idptest.Serve(idpAddr, clientID, secret, accounts(n))
	if err != nil {
		return fmt.Errorf("fake IdP: %w", err)
	}
	defer idp.Server.Close()
	public := "http://" + apiAddr
	env := map[string]string{
		"CHAT_ENV":           config.EnvDevelopment,
		"CHAT_LISTEN_ADDR":   apiAddr,
		"CHAT_PUBLIC_URL":    public,
		"DATABASE_URL":       dbURL,
		"OIDC_ISSUER":        idp.Issuer(),
		"OIDC_CLIENT_ID":     clientID,
		"OIDC_CLIENT_SECRET": secret,
		"SESSION_KEY":        randomBase64(32),
		// Every fake person signs up from this machine.
		"ABUSE_SIGNUPS_PER_IP_HOUR": "0",
		"ABUSE_SIGNUPS_PER_10MIN":   "0",
	}
	cfg, err := config.Load(func(name string) (string, bool) { v, ok := env[name]; return v, ok })
	if err != nil {
		return fmt.Errorf("configuration: %w", err)
	}
	go func() {
		for ctx.Err() == nil {
			if resp, err := http.Get(public + "/healthz"); err == nil {
				_ = resp.Body.Close()
				if resp.StatusCode == http.StatusOK {
					fmt.Printf("loadgen stack ready: api %s, fake IdP %s, %d accounts, server pid %d\n", public, idp.Issuer(), n, os.Getpid())
					return
				}
			}
			time.Sleep(200 * time.Millisecond)
		}
	}()
	return api.Run(ctx, cfg, logger)
}

// idpMain serves only the fake IdP, for a load-test tenant elsewhere.
func idpMain(args []string) int {
	flags := flag.NewFlagSet("idp", flag.ContinueOnError)
	addr := flags.String("addr", "127.0.0.1:4710", "listen address")
	n := flags.Int("accounts", 2000, "fake people")
	secretFile := flags.String("secret-file", "", "file the client secret is written to (mode 600)")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *secretFile == "" {
		fmt.Fprintln(os.Stderr, "loadgen idp: -secret-file is required")
		return 2
	}
	secret := randomBase64(24)
	if err := os.WriteFile(*secretFile, []byte(secret), 0o600); err != nil {
		fmt.Fprintln(os.Stderr, "loadgen idp:", err)
		return 1
	}
	idp, err := idptest.Serve(*addr, clientID, secret, accounts(*n))
	if err != nil {
		fmt.Fprintln(os.Stderr, "loadgen idp:", err)
		return 1
	}
	defer idp.Server.Close()
	fmt.Printf("loadgen idp ready: issuer %s, client %s, %d accounts\n", idp.Issuer(), clientID, *n)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()
	return 0
}
