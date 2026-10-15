// Command e2e-stack runs the whole backend on the developer's machine for
// multi-user end-to-end tests and manual testing with several browsers:
// a throwaway PostgreSQL, a fake IdP whose sign-in page lets each browser
// pick a test account, and the real api role pointed at both.
//
//	go run ./cmd/e2e-stack
//
// It is never deployed (infra/chat/deploy.sh builds only ./cmd/server) and
// changes nothing in the production code path: users sign in through the
// same OIDC flow as in production, only against a fake provider. Every run
// starts from an empty database. The web app is the Vite dev server
// (pnpm --filter @app/web dev), which proxies /rpc, /auth and /ws here.
// POST /e2e/realtime on the api port drops and restores the realtime
// sockets (realtime_switch.go).
package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"app.local/server/internal/api"
	"app.local/server/internal/auth/idptest"
	"app.local/server/internal/config"
	"app.local/server/internal/store"
	"app.local/server/internal/store/testdb"
)

// Accounts are the test people offered on the fake IdP's sign-in page.
var Accounts = []idptest.Account{
	{Sub: "acc_e2e_an", SID: "sid-an", PreferredUsername: "an", Name: "An", Email: "an@e2e.test", EmailVerified: true},
	{Sub: "acc_e2e_binh", SID: "sid-binh", PreferredUsername: "binh", Name: "Bình", Email: "binh@e2e.test", EmailVerified: true},
	{Sub: "acc_e2e_chi", SID: "sid-chi", PreferredUsername: "chi", Name: "Chi", Email: "chi@e2e.test", EmailVerified: true},
	// Kept for scenarios that need an account nobody has talked to yet.
	{Sub: "acc_e2e_dung", SID: "sid-dung", PreferredUsername: "dung", Name: "Dũng", Email: "dung@e2e.test", EmailVerified: true},
	// A brand-new account for the assistant bot scenario.
	{Sub: "acc_e2e_giang", SID: "sid-giang", PreferredUsername: "giang", Name: "Giang", Email: "giang@e2e.test", EmailVerified: true},
}

// operatorSub is the account that may use the moderation queue (Chi): it
// is created before the api starts so its id can go into
// CHAT_OPERATOR_USER_IDS.
const operatorSub = "acc_e2e_chi"

const clientID = "chat-web"

func main() {
	os.Exit(run(os.Args[1:], os.Stderr))
}

func run(args []string, stderr io.Writer) int {
	flags := flag.NewFlagSet("e2e-stack", flag.ContinueOnError)
	flags.SetOutput(stderr)
	apiAddr := flags.String("api", "127.0.0.1:4600", "api listen address (the Vite dev server proxies to it)")
	idpAddr := flags.String("idp", "127.0.0.1:4610", "fake IdP listen address")
	pgPort := flags.Uint("pg-port", 4630, "PostgreSQL port on 127.0.0.1")
	public := flags.String("public", "http://localhost:5173", "origin the browsers open (the Vite dev server)")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	logger := slog.New(slog.NewTextHandler(stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	if err := serve(*apiAddr, *idpAddr, uint32(*pgPort), *public, logger); err != nil {
		_, _ = fmt.Fprintln(stderr, "e2e-stack:", err)
		return 1
	}
	return 0
}

func serve(apiAddr, idpAddr string, pgPort uint32, public string, logger *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	dir, err := os.MkdirTemp("", "chat-e2e-")
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

	operator, err := createOperator(ctx, dbURL)
	if err != nil {
		return fmt.Errorf("operator account: %w", err)
	}

	secret, sessionKey := randomBase64(24), randomBase64(32)
	idp, err := idptest.Serve(idpAddr, clientID, secret, Accounts)
	if err != nil {
		return fmt.Errorf("fake IdP: %w", err)
	}
	defer idp.Server.Close()

	mediaRoot := filepath.Join(dir, "media")
	if err := os.MkdirAll(mediaRoot, 0o700); err != nil {
		return err
	}
	env := map[string]string{
		"CHAT_ENV":             config.EnvDevelopment,
		"CHAT_LISTEN_ADDR":     apiAddr,
		"CHAT_PUBLIC_URL":      public,
		"DATABASE_URL":         dbURL,
		"OIDC_ISSUER":          idp.Issuer(),
		"OIDC_CLIENT_ID":       clientID,
		"OIDC_CLIENT_SECRET":   secret,
		"SESSION_KEY":          sessionKey,
		"MEDIA_PUBLIC_URL":     mediaURL(apiAddr),
		"MEDIA_ROOT":           mediaRoot,
		"MEDIA_MIN_FREE_BYTES": "0",
		// The bots scenario runs its webhook receiver on loopback over http.
		"BOT_WEBHOOK_ALLOW_LOCAL": "true",
		"CHAT_OPERATOR_USER_IDS":  strconv.FormatInt(operator, 10),
	}
	cfg, err := config.Load(func(name string) (string, bool) { v, ok := env[name]; return v, ok })
	if err != nil {
		return fmt.Errorf("configuration: %w", err)
	}

	go announceReady(ctx, apiAddr, public, idp.Issuer())
	return api.RunWrapped(ctx, cfg, logger, newRealtimeSwitch().wrap)
}

// createOperator creates the operator's account as its first sign-in
// would, in the tenant the api uses by default, and returns its id.
func createOperator(ctx context.Context, dbURL string) (int64, error) {
	st, err := store.Open(ctx, dbURL)
	if err != nil {
		return 0, err
	}
	defer st.Close()
	if err := st.EnsureTenant(ctx, config.DefaultTenantID, config.DefaultTenantDomain, config.DefaultTenantDomain); err != nil {
		return 0, err
	}
	for _, a := range Accounts {
		if a.Sub != operatorSub {
			continue
		}
		u, err := st.UpsertIdPUser(ctx, config.DefaultTenantID, store.IdPProfile{
			Sub: a.Sub, PreferredUsername: a.PreferredUsername, Name: a.Name,
			Email: store.IdPEmail{Email: a.Email, Verified: a.EmailVerified},
		})
		return u.ID, err
	}
	return 0, fmt.Errorf("no account %s", operatorSub)
}

// announceReady prints one line once the api answers, so a runner can wait
// for it.
func announceReady(ctx context.Context, apiAddr, public, issuer string) {
	for ctx.Err() == nil {
		resp, err := http.Get("http://" + apiAddr + "/healthz")
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				fmt.Printf("e2e-stack ready: open %s (fake IdP %s; accounts an, binh, chi, dung)\n", public, issuer)
				return
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// mediaURL is the media origin: the api port under the name media.localhost,
// which browsers resolve to loopback by themselves. The api tells media
// requests apart by Host, and the Vite proxy sends app requests with Host
// 127.0.0.1, so the media host must be a different name.
func mediaURL(apiAddr string) string {
	_, port, _ := net.SplitHostPort(apiAddr)
	return "http://media.localhost:" + port
}

// randomBase64 is URL-safe so the client secret survives the form-encoding
// of client_secret_basic unchanged.
func randomBase64(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}
