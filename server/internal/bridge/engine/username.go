package engine

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"app.local/server/internal/bridge"
	"app.local/server/internal/profile"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// statedUsername is the username the other app states for p as a Chat username, "" when it
// states none or none that Chat accepts (too short, or in the range kept for puppets).
func statedUsername(p bridge.Participant) string {
	u := profile.UsernameBase(strings.TrimPrefix(p.Username, "@"))
	if !profile.ValidUsername(u) {
		return ""
	}
	return u
}

// usernameTaken says whether err is a clash with another user's username.
func usernameTaken(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23505" && pg.ConstraintName == "users_tenant_username_key"
}

// insertPuppetUser inserts the puppet user, with the username the other app states when
// it is free. The first holder of a name keeps it: a later person with the same name
// (from the other app or a second account) gets the placeholder name instead and the
// clash is logged for a person to look at.
func insertPuppetUser(ctx context.Context, tx pgx.Tx, tenantID string, id int64, p bridge.Participant, name, source string) error {
	const insert = `
		INSERT INTO users (id, tenant_id, idp_sub, username, name, external_source, last_seen_at)
		VALUES ($1, $2, NULL, $3, $4, $5, $6)`
	seen := seenPtr(p)
	placeholder := fmt.Sprintf("%s%d", profile.ExternalUsernamePrefix, id)
	if want := statedUsername(p); want != "" {
		err := pgx.BeginFunc(ctx, tx, func(sp pgx.Tx) error {
			_, err := sp.Exec(ctx, insert, id, tenantID, want, name, source, seen)
			return err
		})
		if err == nil {
			return nil
		}
		if !usernameTaken(err) {
			return fmt.Errorf("bridge: create puppet: %w", err)
		}
		slog.Warn("bridge: stated username already taken, placeholder name kept", "source", source, "user_id", id)
	}
	if _, err := tx.Exec(ctx, insert, id, tenantID, placeholder, name, source, seen); err != nil {
		return fmt.Errorf("bridge: create puppet: %w", err)
	}
	return nil
}

// adoptUsername gives a puppet that still has its placeholder name the username the other
// app now states, when it is free. A name once adopted is not changed again, so a rename
// in the other app does not move a handle people may have used.
func (d *db) adoptUsername(ctx context.Context, userID int64, current string, p bridge.Participant, source string) error {
	if !strings.HasPrefix(current, profile.ExternalUsernamePrefix) {
		return nil
	}
	want := statedUsername(p)
	if want == "" {
		return nil
	}
	_, err := d.pool.Exec(ctx, `UPDATE users SET username = $2, updated_at = now() WHERE id = $1 AND username = $3 AND deleted_at IS NULL`, userID, want, current)
	if err == nil {
		return nil
	}
	if usernameTaken(err) {
		slog.Warn("bridge: stated username already taken, placeholder name kept", "source", source, "user_id", userID)
		return nil
	}
	return fmt.Errorf("bridge: adopt username: %w", err)
}
