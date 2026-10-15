package store_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"net/url"
	"strings"
	"testing"

	"app.local/server/internal/store"
	"app.local/server/internal/store/testdb"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// scratchCluster creates, as the superuser of the test server, a login role
// and a database (owned by the role when owned is set, else by the
// superuser) and returns the superuser URL of that database and the role's
// URL. Both are dropped when the test ends.
func scratchCluster(t *testing.T, owned bool) (adminURL, roleURL string) {
	t.Helper()
	ctx := context.Background()
	base := testdb.New(t)
	admin, err := pgx.Connect(ctx, base)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = admin.Close(context.Background()) })
	var suffix [6]byte
	_, _ = rand.Read(suffix[:])
	role := "r_" + hex.EncodeToString(suffix[:])
	db := "d_" + hex.EncodeToString(suffix[:])
	const password = "scratch-only"
	owner := "postgres"
	if owned {
		owner = role
	}
	for _, sql := range []string{
		"CREATE ROLE " + role + " LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '" + password + "'",
		"CREATE DATABASE " + db + " OWNER " + owner,
	} {
		if _, err := admin.Exec(ctx, sql); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	t.Cleanup(func() {
		ctx := context.Background()
		if _, err := admin.Exec(ctx, "DROP DATABASE "+db+" WITH (FORCE)"); err != nil {
			t.Errorf("drop database: %v", err)
		}
		if _, err := admin.Exec(ctx, "DROP ROLE "+role); err != nil {
			t.Errorf("drop role: %v", err)
		}
	})
	u, err := url.Parse(base)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + db
	adminURL = u.String()
	u.User = url.UserPassword(role, password)
	return adminURL, u.String()
}

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// pg_trgm is a trusted extension (PostgreSQL 13+): the owner of the
// database, not a superuser, runs every migration and owns the extension.
func TestMigrateCreatesTrigramExtensionAsDatabaseOwner(t *testing.T) {
	ctx := context.Background()
	_, roleURL := scratchCluster(t, true)
	if err := store.Migrate(ctx, roleURL, quietLogger()); err != nil {
		t.Fatalf("migrate as the database owner: %v", err)
	}
	conn, err := pgx.Connect(ctx, roleURL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(ctx) }()
	var owner, self string
	if err := conn.QueryRow(ctx, `SELECT e.extowner::regrole::text, current_user FROM pg_extension e WHERE e.extname = 'pg_trgm'`).Scan(&owner, &self); err != nil {
		t.Fatalf("pg_trgm not created: %v", err)
	}
	if owner != self {
		t.Fatalf("pg_trgm owned by %s, not %s", owner, self)
	}
}

// A role without CREATE on the database cannot create the extension: the
// migration fails with permission denied and leaves the schema at the
// previous version, so the previous release keeps running.
func TestMigrateWithoutCreateOnDatabaseFails(t *testing.T) {
	ctx := context.Background()
	adminURL, roleURL := scratchCluster(t, false)
	admin, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = admin.Close(ctx) }()
	role, err := url.Parse(roleURL)
	if err != nil {
		t.Fatal(err)
	}
	// Tables in public, but not CREATE on the database.
	if _, err := admin.Exec(ctx, "GRANT CREATE ON SCHEMA public TO "+role.User.Username()); err != nil {
		t.Fatal(err)
	}
	err = store.Migrate(ctx, roleURL, quietLogger())
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "42501" || !strings.Contains(pgErr.Message, "pg_trgm") {
		t.Fatalf("migrate without CREATE on the database: %v", err)
	}
	var version int64
	var hasColumn bool
	if err := admin.QueryRow(ctx, `SELECT
			(SELECT max(version_id) FROM goose_db_version WHERE is_applied),
			EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'messages' AND column_name = 'search_text')`).Scan(&version, &hasColumn); err != nil {
		t.Fatal(err)
	}
	if version != 11 || hasColumn {
		t.Fatalf("after the failed migration: version %d, search_text column %t", version, hasColumn)
	}
}
