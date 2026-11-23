package store_test

import (
	"context"
	"database/sql"
	"testing"

	"app.local/server/internal/store/testdb"
	"app.local/server/migrations"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

// The Chat Bridge per-account sending switch is gone from the migrated schema; going
// down brings the column back off for every account, and up drops it again.
func TestBridgeSendSwitchColumnIsDropped(t *testing.T) {
	ctx := context.Background()
	url := testdb.New(t)
	cfg, err := pgx.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	db := stdlib.OpenDB(*cfg)
	t.Cleanup(func() { _ = db.Close() })
	provider, err := goose.NewProvider(goose.DialectPostgres, db, migrations.FS, goose.WithDisableGlobalRegistry(true))
	if err != nil {
		t.Fatal(err)
	}
	if hasSendEnabled(ctx, t, db) {
		t.Fatal("external_accounts.send_enabled exists after migrating")
	}

	if _, err := provider.DownTo(ctx, 58); err != nil {
		t.Fatalf("down: %v", err)
	}
	if !hasSendEnabled(ctx, t, db) {
		t.Fatal("down did not bring external_accounts.send_enabled back")
	}
	var def string
	if err := db.QueryRowContext(ctx, `
		SELECT column_default FROM information_schema.columns
		WHERE table_name = 'external_accounts' AND column_name = 'send_enabled'`).Scan(&def); err != nil || def != "false" {
		t.Fatalf("default after down = %q, %v; want false", def, err)
	}
	if _, err := provider.UpTo(ctx, 59); err != nil {
		t.Fatalf("up: %v", err)
	}
	if hasSendEnabled(ctx, t, db) {
		t.Fatal("up did not drop external_accounts.send_enabled")
	}
}

func hasSendEnabled(ctx context.Context, t *testing.T, db *sql.DB) bool {
	t.Helper()
	var n int
	if err := db.QueryRowContext(ctx, `
		SELECT count(*) FROM information_schema.columns
		WHERE table_name = 'external_accounts' AND column_name = 'send_enabled'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n == 1
}
