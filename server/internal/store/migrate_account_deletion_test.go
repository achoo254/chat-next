package store_test

import (
	"context"
	"testing"

	"app.local/server/internal/store"
	"app.local/server/internal/store/testdb"
	"app.local/server/migrations"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

// The migration to deletion at the IdP turns the auto-delete setting off,
// accepts the 'idp' reason, keeps the accounts in the old grace period
// queued (the job erases them), and goes down and up again cleanly.
func TestAccountDeletionAtIdPMigration(t *testing.T) {
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
	if _, err := provider.DownTo(ctx, 37); err != nil {
		t.Fatalf("down: %v", err)
	}
	st, err := store.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	if err := st.EnsureTenant(ctx, tenant, "hoandat.com", "hoandat.com"); err != nil {
		t.Fatal(err)
	}
	user := func(sub, name string) int64 {
		t.Helper()
		u, err := st.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: sub, PreferredUsername: name})
		if err != nil {
			t.Fatal(err)
		}
		return u.ID
	}
	unused, pending := user("acc_1", "dat"), user("acc_2", "lan")
	if _, err := db.ExecContext(ctx, `UPDATE users SET auto_delete_months = 12 WHERE id = $1`, unused); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE users SET deletion_requested_at = now(), deletion_reason = 'user' WHERE id = $1`, pending); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE users SET deletion_reason = 'idp' WHERE id = $1`, pending); err == nil {
		t.Fatal("'idp' accepted before the migration")
	}

	if _, err := provider.UpTo(ctx, 38); err != nil {
		t.Fatalf("up: %v", err)
	}
	var months int
	if err := db.QueryRowContext(ctx, `SELECT auto_delete_months FROM users WHERE id = $1`, unused).Scan(&months); err != nil || months != 0 {
		t.Fatalf("auto-delete after the migration: %d %v", months, err)
	}
	var reason string
	if err := db.QueryRowContext(ctx, `SELECT deletion_reason FROM users WHERE id = $1 AND deletion_requested_at IS NOT NULL`, pending).
		Scan(&reason); err != nil || reason != "user" {
		t.Fatalf("queued account after the migration: %q %v", reason, err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE users SET deletion_reason = 'idp' WHERE id = $1`, pending); err != nil {
		t.Fatalf("'idp' refused: %v", err)
	}

	if _, err := provider.DownTo(ctx, 37); err != nil {
		t.Fatalf("down again: %v", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT deletion_reason FROM users WHERE id = $1`, pending).Scan(&reason); err != nil || reason != "user" {
		t.Fatalf("'idp' after going down: %q %v", reason, err)
	}
	if _, err := provider.UpTo(ctx, 38); err != nil {
		t.Fatalf("up again: %v", err)
	}
}
