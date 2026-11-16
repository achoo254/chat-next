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

// The Advisor profile migration goes down and up again cleanly: down drops
// the table and the advisor_profile outbox rows, up takes the new kind again,
// and erasing an account deletes its profile.
func TestAdvisorProfilesMigration(t *testing.T) {
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
	st, err := store.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	if err := st.EnsureTenant(ctx, tenant, "hoandat.com", "hoandat.com"); err != nil {
		t.Fatal(err)
	}
	u, err := st.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_1", PreferredUsername: "dat"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO advisor_profiles (user_id, name, look_id, tone) VALUES ($1, 'Cú', 'owl', 2)`, u.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO advisor_profiles (user_id, look_id) VALUES ($1, 'Owl')`, u.ID); err == nil {
		t.Fatal("a look id outside the pattern was accepted")
	}

	if _, err := provider.DownTo(ctx, 40); err != nil {
		t.Fatalf("down: %v", err)
	}
	var exists bool
	if err := db.QueryRowContext(ctx, `SELECT to_regclass('advisor_profiles') IS NOT NULL`).Scan(&exists); err != nil || exists {
		t.Fatalf("advisor_profiles after down: %v, %v", exists, err)
	}
	if _, err := provider.UpTo(ctx, 41); err != nil {
		t.Fatalf("up: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO advisor_profiles (user_id) VALUES ($1)`, u.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE users SET deleted_at = now() WHERE id = $1`, u.ID); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM advisor_profiles WHERE user_id = $1`, u.ID).Scan(&n); err != nil || n != 0 {
		t.Fatalf("%d profiles after erasure, %v", n, err)
	}
}
