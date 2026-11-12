package store_test

import (
	"bytes"
	"context"
	"testing"

	"app.local/server/internal/store"
	"app.local/server/internal/store/testdb"
	"app.local/server/migrations"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

// The account-device migration goes down and up again cleanly, and a
// machine key registered twice before it (both rows live) keeps only the
// row seen last, so one live row per key can be enforced.
func TestAccountDevicesMigration(t *testing.T) {
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
	if _, err := provider.DownTo(ctx, 36); err != nil {
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
	u, err := st.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_1", PreferredUsername: "dat"})
	if err != nil {
		t.Fatal(err)
	}
	insert := func(key byte, secret byte, seen string, revoked bool) int64 {
		t.Helper()
		var id int64
		if err := db.QueryRowContext(ctx, `
			INSERT INTO machines (tenant_id, user_id, name, os, arch, agent_version, public_key, secret_hash, last_seen_at, revoked_at)
			VALUES ($1, $2, 'm', 'linux', 'x64', '2.7.1', $3, $4, now() - $5::interval, CASE WHEN $6 THEN now() END)
			RETURNING id`, tenant, u.ID, bytes.Repeat([]byte{key}, 32), bytes.Repeat([]byte{secret}, 32), seen, revoked).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	older := insert(1, 1, "2 days", false)
	newer := insert(1, 2, "1 hour", false)
	gone := insert(1, 3, "1 minute", true)
	alone := insert(2, 4, "3 days", false)

	if _, err := provider.UpTo(ctx, 37); err != nil {
		t.Fatalf("up: %v", err)
	}
	live := map[int64]bool{}
	rows, err := db.QueryContext(ctx, `SELECT id, revoked_at IS NULL FROM machines`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var id int64
		var isLive bool
		if err := rows.Scan(&id, &isLive); err != nil {
			t.Fatal(err)
		}
		live[id] = isLive
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if live[older] || !live[newer] || live[gone] || !live[alone] {
		t.Fatalf("live rows after the migration: %v (older %d, newer %d, gone %d, alone %d)", live, older, newer, gone, alone)
	}
	if _, err := db.ExecContext(ctx, `UPDATE machines SET revoked_at = NULL WHERE id = $1`, older); err == nil {
		t.Fatal("a second live row of one key was accepted")
	}
}
