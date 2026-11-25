package store_test

import (
	"context"
	"database/sql"
	"strings"
	"testing"

	"app.local/server/internal/store/testdb"
	"app.local/server/migrations"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

// The hidden-from-AI migrations go down and up again cleanly: down drops the
// columns, the index and the new outbox kind; up brings them back, with a
// valid index and a validated check that takes the new kind.
func TestHiddenFromAIMigrations(t *testing.T) {
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

	type state struct {
		hiddenColumn, viaAIColumn, index, indexValid, checkValid, checkHasKind bool
	}
	read := func() state {
		t.Helper()
		var s state
		var check sql.NullString
		if err := db.QueryRowContext(ctx, `
			SELECT
				EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'chat_members' AND column_name = 'hidden_from_ai'),
				EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'messages' AND column_name = 'via_ai'),
				EXISTS (SELECT 1 FROM pg_class WHERE relname = 'chat_members_hidden_from_ai_idx'),
				coalesce((SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
					WHERE c.relname = 'chat_members_hidden_from_ai_idx'), false),
				coalesce((SELECT convalidated FROM pg_constraint WHERE conname = 'outbox_kind_check' AND conrelid = 'outbox'::regclass), false),
				(SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'outbox_kind_check' AND conrelid = 'outbox'::regclass)`,
		).Scan(&s.hiddenColumn, &s.viaAIColumn, &s.index, &s.indexValid, &s.checkValid, &check); err != nil {
			t.Fatal(err)
		}
		s.checkHasKind = strings.Contains(check.String, "dialog_hidden_from_ai")
		var others int
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM pg_constraint WHERE conname = 'outbox_kind_check_next'`).Scan(&others); err != nil || others != 0 {
			t.Fatalf("leftover outbox_kind_check_next: %d, %v", others, err)
		}
		return s
	}

	up := state{hiddenColumn: true, viaAIColumn: true, index: true, indexValid: true, checkValid: true, checkHasKind: true}
	if got := read(); got != up {
		t.Fatalf("migrated = %+v", got)
	}
	if _, err := provider.DownTo(ctx, 62); err != nil {
		t.Fatalf("down: %v", err)
	}
	// The narrower check is validated again too.
	if got := read(); got != (state{checkValid: true}) {
		t.Fatalf("after down = %+v", got)
	}
	if _, err := provider.UpTo(ctx, 65); err != nil {
		t.Fatalf("up: %v", err)
	}
	if got := read(); got != up {
		t.Fatalf("after up = %+v", got)
	}
}
