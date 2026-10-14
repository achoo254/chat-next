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

	"app.local/server/migrations"
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

// Open connects to the database and verifies the connection with a ping.
func Open(ctx context.Context, databaseURL string) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, errInvalidURL
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

// Migrate applies every pending embedded migration. A Postgres advisory lock
// serializes concurrent runs.
func Migrate(ctx context.Context, databaseURL string, logger *slog.Logger) error {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return errInvalidURL
	}
	db := stdlib.OpenDB(*cfg.ConnConfig)
	defer func() { _ = db.Close() }()
	return migrate(ctx, db, logger)
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
