package botadmin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/profile"
	"app.local/server/internal/store"
	"github.com/jackc/pgx/v5"
)

// SystemBot describes the tenant's assistant bot. EnsureSystemBot applies
// it at every start, so a brand rename or new copy reaches the bot without
// a migration.
type SystemBot struct {
	Username    string
	Name        string
	Description string
	About       string
	Commands    []CommandSet
}

// ErrSystemUsernameTaken: another account already holds the assistant's
// username, so the assistant cannot be created in this tenant.
var ErrSystemUsernameTaken = errors.New("botadmin: the assistant's username belongs to another account")

// EnsureSystemBot creates the tenant's assistant on the first call and
// brings its profile up to date on later ones; it returns the bot. The
// assistant is verified, in the internal tier, has no token (only the api
// process drives it), owns itself (no user's bot limit or Developer
// Console sees it) and cannot be added to groups. Concurrent starts are
// serialized by a transaction advisory lock.
func (s *Service) EnsureSystemBot(ctx context.Context, spec SystemBot) (*Bot, error) {
	username := profile.NormalizeUsername(spec.Username)
	if !botUsername.MatchString(username) {
		return nil, fmt.Errorf("botadmin: assistant username %q is not a bot username", spec.Username)
	}
	name, err := profile.CleanName(spec.Name)
	if err != nil {
		return nil, fmt.Errorf("botadmin: assistant name: %w", err)
	}
	description, err := cleanText(spec.Description, descriptionMax, "description")
	if err != nil {
		return nil, err
	}
	about, err := cleanText(spec.About, aboutMax, "about")
	if err != nil {
		return nil, err
	}
	sets := make([]CommandSet, 0, len(spec.Commands))
	for _, set := range spec.Commands {
		if !validScope(set.Scope) {
			return nil, fmt.Errorf("botadmin: assistant command scope %q", set.Scope)
		}
		clean, err := checkCommands(set.Commands)
		if err != nil {
			return nil, err
		}
		sets = append(sets, CommandSet{Scope: set.Scope, Commands: clean})
	}
	commands, err := json.Marshal(sets)
	if err != nil {
		return nil, fmt.Errorf("botadmin: encode commands: %w", err)
	}
	var bot *Bot
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('system-bot:' || $1, 0))`, s.tenantID); err != nil {
			return fmt.Errorf("botadmin: lock assistant: %w", err)
		}
		var id int64
		err := tx.QueryRow(ctx, `SELECT user_id FROM bots WHERE tenant_id = $1 AND is_system`, s.tenantID).Scan(&id)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			if id, err = s.createSystemBot(ctx, tx, username, name); err != nil {
				return err
			}
		case err != nil:
			return fmt.Errorf("botadmin: find assistant: %w", err)
		default:
			if _, err := tx.Exec(ctx, `UPDATE users SET name = $2, updated_at = now() WHERE id = $1 AND name <> $2`, id, name); err != nil {
				return fmt.Errorf("botadmin: rename assistant: %w", err)
			}
		}
		if _, err := tx.Exec(ctx, `
			UPDATE bots SET description = $2, about = $3, commands = $4, verified = true, internal = true, privacy = true,
				deleted_at = NULL, updated_at = now()
			WHERE user_id = $1`, id, description, about, commands); err != nil {
			return fmt.Errorf("botadmin: update assistant: %w", err)
		}
		bot, err = scanBot(tx.QueryRow(ctx, `SELECT `+botColumns+` FROM `+botFrom+` WHERE b.user_id = $1`, id))
		if err != nil {
			return fmt.Errorf("botadmin: load assistant: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return bot, nil
}

// createSystemBot inserts the assistant's user, bot and privacy rows.
func (s *Service) createSystemBot(ctx context.Context, tx pgx.Tx, username, name string) (int64, error) {
	id, err := store.NextUserID(ctx, tx)
	if err != nil {
		return 0, err
	}
	tag, err := tx.Exec(ctx, `
		INSERT INTO users (id, tenant_id, idp_sub, username, name, is_bot) VALUES ($1, $2, NULL, $3, $4, true)
		ON CONFLICT DO NOTHING`, id, s.tenantID, username, name)
	if err != nil {
		return 0, fmt.Errorf("botadmin: insert assistant user: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return 0, ErrSystemUsernameTaken
	}
	if _, err := tx.Exec(ctx, `INSERT INTO bots (user_id, tenant_id, owner_id, is_system) VALUES ($1, $2, $1, true)`,
		id, s.tenantID); err != nil {
		return 0, fmt.Errorf("botadmin: insert assistant: %w", err)
	}
	// Anyone may write to it; nobody adds it to groups; last seen hidden.
	everyone := int16(appv1.PrivacyAudience_PRIVACY_AUDIENCE_EVERYONE)
	nobody := int16(appv1.PrivacyAudience_PRIVACY_AUDIENCE_NOBODY)
	if _, err := tx.Exec(ctx, `
		INSERT INTO privacy_settings (user_id, add_to_groups, send_messages, last_seen) VALUES ($1, $2, $3, $2)`,
		id, nobody, everyone); err != nil {
		return 0, fmt.Errorf("botadmin: assistant privacy: %w", err)
	}
	s.logger.Info("assistant bot created", "bot_id", id, "username", username)
	return id, nil
}
