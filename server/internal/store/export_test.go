package store

import (
	"context"
	"testing"

	"app.local/server/migrations"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

// ExpireGrantLeases moves every grant check lease into the past, as if the
// checks holding them had crashed long ago.
func ExpireGrantLeases(t *testing.T, s *Store) {
	t.Helper()
	if _, err := s.pool.Exec(context.Background(),
		`UPDATE user_sessions SET grant_lease_until = now() - interval '1 second' WHERE grant_lease_until IS NOT NULL`); err != nil {
		t.Fatal(err)
	}
}

// RollBackAndReapplyLatest runs the newest migration's Down and then Up
// again, so every Down section stays executable.
func RollBackAndReapplyLatest(t *testing.T, s *Store) int64 {
	t.Helper()
	ctx := context.Background()
	db := stdlib.OpenDBFromPool(s.pool)
	defer func() { _ = db.Close() }()
	provider, err := goose.NewProvider(goose.DialectPostgres, db, migrations.FS, goose.WithDisableGlobalRegistry(true))
	if err != nil {
		t.Fatal(err)
	}
	down, err := provider.Down(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.Up(ctx); err != nil {
		t.Fatal(err)
	}
	return down.Source.Version
}
