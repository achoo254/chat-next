// Package store is the PostgreSQL data-access layer: connection pool,
// embedded migrations and the queries for tenants, users and chat sessions.
// Every query that touches tenant data filters by tenant_id (ADR 0010).
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"app.local/server/internal/search"
	"app.local/server/migrations"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"
)

// ErrNotFound reports a row that does not exist (or is not visible to the
// caller's tenant or user).
var ErrNotFound = errors.New("store: not found")

// Store wraps the connection pool.
type Store struct {
	pool *pgxpool.Pool
}

// errInvalidURL is returned instead of the pgx parse error, which may echo
// parts of the connection string.
var errInvalidURL = errors.New("store: invalid database URL")

// defaultMaxConns is the pool size when DATABASE_URL sets no
// pool_max_conns (pgx would otherwise use max(4, number of CPUs)).
const defaultMaxConns = 10

// poolConfig parses databaseURL and applies defaultMaxConns unless the URL
// sets pool_max_conns itself.
func poolConfig(databaseURL string) (*pgxpool.Config, error) {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, errInvalidURL
	}
	// ParseConfig removes pool_* settings from the parsed config, so look at
	// the URL (or key=value string) itself.
	if !strings.Contains(databaseURL, "pool_max_conns") {
		cfg.MaxConns = defaultMaxConns
	}
	return cfg, nil
}

// Open connects to the database and verifies the connection with a ping.
func Open(ctx context.Context, databaseURL string) (*Store, error) {
	cfg, err := poolConfig(databaseURL)
	if err != nil {
		return nil, err
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("store: open pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("store: ping: %w", err)
	}
	return &Store{pool: pool}, nil
}

// Close releases every pooled connection.
func (s *Store) Close() {
	s.pool.Close()
}

// Ping checks that the database answers.
func (s *Store) Ping(ctx context.Context) error {
	return s.pool.Ping(ctx)
}

// Migrate applies every pending embedded migration, then indexes for search
// the messages that are not indexed yet (search.Backfill). A Postgres
// advisory lock serializes concurrent migration runs; the backfill is
// idempotent.
func Migrate(ctx context.Context, databaseURL string, logger *slog.Logger) error {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return errInvalidURL
	}
	db := stdlib.OpenDB(*cfg.ConnConfig)
	defer func() { _ = db.Close() }()
	if err := migrate(ctx, db, logger); err != nil {
		return err
	}
	conn, err := pgx.ConnectConfig(ctx, cfg.ConnConfig)
	if err != nil {
		return fmt.Errorf("store: connect for search backfill: %w", err)
	}
	defer func() { _ = conn.Close(context.WithoutCancel(ctx)) }()
	if _, err := search.Backfill(ctx, conn, logger); err != nil {
		return err
	}
	return nil
}

func migrate(ctx context.Context, db *sql.DB, logger *slog.Logger) error {
	locker, err := lock.NewPostgresSessionLocker()
	if err != nil {
		return fmt.Errorf("store: migration locker: %w", err)
	}
	provider, err := goose.NewProvider(goose.DialectPostgres, db, migrations.FS,
		goose.WithSessionLocker(locker),
		goose.WithDisableGlobalRegistry(true),
	)
	if err != nil {
		return fmt.Errorf("store: migration provider: %w", err)
	}
	results, err := provider.Up(ctx)
	if err != nil {
		return fmt.Errorf("store: migrate: %w", err)
	}
	for _, r := range results {
		logger.Info("migration applied", "version", r.Source.Version, "path", r.Source.Path, "duration", r.Duration)
	}
	return nil
}

// Pool returns the connection pool, for domain packages that run their own
// queries and transactions (chats, messages, sync logs).
func (s *Store) Pool() *pgxpool.Pool {
	return s.pool
}
