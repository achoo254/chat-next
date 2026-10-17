// Command server is the single backend binary; each deployment runs one
// role of it, and every role scales on its own.
//
//	server -role api [-env-file /etc/chat/chat.env]
//	server -role migrate [-env-file /etc/chat/chat.env]
//	server -role reseal [-env-file /etc/chat/chat.env]
//
// Configuration comes from environment variables (see internal/config);
// -env-file loads KEY=VALUE lines without overriding variables already set.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"slices"
	"strings"

	"app.local/server/internal/api"
	"app.local/server/internal/config"
	"app.local/server/internal/logging/redact"
	"app.local/server/internal/store"
	"app.local/server/internal/watch"
)

// Roles are the processes the binary can run.
var Roles = []string{"api", "migrate", "reseal", "gateway", "worker", "botapi", "webhook"}

func main() {
	os.Exit(run(os.Args[1:], os.Stderr))
}

// run parses the command line and returns the process exit code: 2 for
// usage errors, 1 for configuration or runtime failures.
func run(args []string, stderr io.Writer) int {
	flags := flag.NewFlagSet("server", flag.ContinueOnError)
	flags.SetOutput(stderr)
	role := flags.String("role", "", "role to run: "+strings.Join(Roles, ", "))
	envFile := flags.String("env-file", "", "file of KEY=VALUE lines to load (never overrides set variables)")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if !slices.Contains(Roles, *role) {
		_, _ = fmt.Fprintf(stderr, "unknown role %q; choose one of: %s\n", *role, strings.Join(Roles, ", "))
		return 2
	}
	if *envFile != "" {
		if err := config.LoadEnvFile(*envFile); err != nil {
			_, _ = fmt.Fprintln(stderr, err)
			return 1
		}
	}
	// The watchdog counts this process's error records (package watch).
	logger := slog.New(watch.Process.Handler(slog.NewJSONHandler(stderr, redact.HandlerOptions(slog.LevelInfo)))).With("role", *role)
	ctx := context.Background()

	switch *role {
	case "api":
		cfg, err := config.Load(os.LookupEnv)
		if err != nil {
			_, _ = fmt.Fprintf(stderr, "invalid configuration:\n%v\n", err)
			return 1
		}
		if err := api.Run(ctx, cfg, logger); err != nil {
			logger.Error("api stopped", "err", err)
			return 1
		}
		return 0
	case "migrate":
		url, err := config.LoadDatabaseURL(os.LookupEnv)
		if err != nil {
			_, _ = fmt.Fprintf(stderr, "invalid configuration:\n%v\n", err)
			return 1
		}
		if err := store.Migrate(ctx, url, logger); err != nil {
			logger.Error("migration failed", "err", err)
			return 1
		}
		logger.Info("migrations up to date")
		return 0
	case "reseal":
		cfg, err := config.Load(os.LookupEnv)
		if err != nil {
			_, _ = fmt.Fprintf(stderr, "invalid configuration:\n%v\n", err)
			return 1
		}
		unreadable, err := reseal(ctx, cfg, logger)
		if err != nil {
			logger.Error("reseal failed", "err", err)
			return 1
		}
		if unreadable > 0 {
			// Those values open under neither key: keep SESSION_KEY_PREVIOUS
			// until the cause is known (docs/operations/key-rotation.md).
			logger.Warn("reseal left unreadable values", "unreadable", unreadable)
			return 1
		}
		return 0
	default:
		_, _ = fmt.Fprintf(stderr, "role %q is not implemented\n", *role)
		return 1
	}
}
