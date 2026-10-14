package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"app.local/server/internal/ids"
	"app.local/server/internal/profile"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// ErrUsernameTaken reports a username already used in the tenant.
var ErrUsernameTaken = errors.New("store: username taken")

// userShard is the shard of every user id until data is split (ADR 0001).
const userShard = 0

// maxUsernameAttempts bounds the candidates tried for a new account.
const maxUsernameAttempts = 20

// User is a chat account.
type User struct {
	ID            int64
	TenantID      string
	IdPSub        string
	Username      string
	Name          string
	Bio           string
	Email         string // empty unless verified at the IdP
	EmailVerified bool
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

// IdPEmail is the email state the IdP reports; only a verified address is
// stored.
type IdPEmail struct {
	Email    string
	Verified bool
}

// stored returns the column values for this email state.
func (e IdPEmail) stored() (*string, bool) {
	if e.Verified && e.Email != "" {
		return &e.Email, true
	}
	return nil, false
}

// IdPProfile carries the ID token claims used to create or refresh a user.
type IdPProfile struct {
	Sub               string
	PreferredUsername string
	Name              string
	Email             IdPEmail
}

const userColumns = `id, tenant_id, idp_sub, username, name, bio, coalesce(email, ''), email_verified, created_at, updated_at`

func scanUser(row pgx.Row) (User, error) {
	var u User
	err := row.Scan(&u.ID, &u.TenantID, &u.IdPSub, &u.Username, &u.Name, &u.Bio, &u.Email, &u.EmailVerified, &u.CreatedAt, &u.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrNotFound
	}
	return u, err
}

// UpsertIdPUser returns the user of (tenantID, profile.Sub), creating it on
// the first sign-in. A new user takes its username from preferred_username
// (digits appended on conflict) and its name from the profile. An existing
// user only gets its email refreshed: the profile belongs to the user after
// creation.
func (s *Store) UpsertIdPUser(ctx context.Context, tenantID string, p IdPProfile) (User, error) {
	if u, err := s.refreshUserEmail(ctx, tenantID, p); !errors.Is(err, ErrNotFound) {
		return u, err
	}
	email, verified := p.Email.stored()
	base := profile.UsernameBase(p.PreferredUsername)
	name := profile.InitialName(p.Name, p.PreferredUsername, base)
	for attempt := range maxUsernameAttempts {
		var local int64
		if err := s.pool.QueryRow(ctx, `SELECT nextval('user_local_id_seq')`).Scan(&local); err != nil {
			return User{}, fmt.Errorf("store: next user id: %w", err)
		}
		id, err := ids.MakeSharded(userShard, local)
		if err != nil {
			return User{}, fmt.Errorf("store: user id: %w", err)
		}
		// No conflict target: a clash on either unique key returns no row.
		u, err := scanUser(s.pool.QueryRow(ctx, `
			INSERT INTO users (id, tenant_id, idp_sub, username, name, email, email_verified)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			ON CONFLICT DO NOTHING
			RETURNING `+userColumns,
			id, tenantID, p.Sub, profile.UsernameCandidate(base, attempt), name, email, verified))
		if err == nil {
			return u, nil
		}
		if !errors.Is(err, ErrNotFound) {
			return User{}, fmt.Errorf("store: insert user: %w", err)
		}
		// Either a concurrent sign-in created this account, or the username
		// is taken; the first case wins.
		if u, err := s.refreshUserEmail(ctx, tenantID, p); !errors.Is(err, ErrNotFound) {
			return u, err
		}
	}
	return User{}, fmt.Errorf("store: no free username for base %q after %d attempts", base, maxUsernameAttempts)
}

func (s *Store) refreshUserEmail(ctx context.Context, tenantID string, p IdPProfile) (User, error) {
	email, verified := p.Email.stored()
	u, err := scanUser(s.pool.QueryRow(ctx, `
		UPDATE users SET email = $3, email_verified = $4,
			updated_at = CASE WHEN email IS DISTINCT FROM $3 OR email_verified <> $4 THEN now() ELSE updated_at END
		WHERE tenant_id = $1 AND idp_sub = $2
		RETURNING `+userColumns,
		tenantID, p.Sub, email, verified))
	if err != nil && !errors.Is(err, ErrNotFound) {
		return User{}, fmt.Errorf("store: refresh user email: %w", err)
	}
	return u, err
}

// UpdateUserEmail stores the email state the IdP reported for a user.
func (s *Store) UpdateUserEmail(ctx context.Context, tenantID string, userID int64, e IdPEmail) error {
	return updateUserEmail(ctx, s.pool, tenantID, userID, e)
}

type execer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

func updateUserEmail(ctx context.Context, db execer, tenantID string, userID int64, e IdPEmail) error {
	email, verified := e.stored()
	_, err := db.Exec(ctx, `
		UPDATE users SET email = $3, email_verified = $4, updated_at = now()
		WHERE tenant_id = $1 AND id = $2 AND (email IS DISTINCT FROM $3 OR email_verified <> $4)`,
		tenantID, userID, email, verified)
	if err != nil {
		return fmt.Errorf("store: update user email: %w", err)
	}
	return nil
}

// UserByID returns a user of the tenant.
func (s *Store) UserByID(ctx context.Context, tenantID string, id int64) (User, error) {
	u, err := scanUser(s.pool.QueryRow(ctx, `SELECT `+userColumns+` FROM users WHERE tenant_id = $1 AND id = $2`, tenantID, id))
	if err != nil && !errors.Is(err, ErrNotFound) {
		return User{}, fmt.Errorf("store: user by id: %w", err)
	}
	return u, err
}

// UpdateProfile sets the fields that are non-nil and returns the user.
func (s *Store) UpdateProfile(ctx context.Context, tenantID string, id int64, name, bio *string) (User, error) {
	u, err := scanUser(s.pool.QueryRow(ctx, `
		UPDATE users SET name = coalesce($3, name), bio = coalesce($4, bio), updated_at = now()
		WHERE tenant_id = $1 AND id = $2
		RETURNING `+userColumns,
		tenantID, id, name, bio))
	if err != nil && !errors.Is(err, ErrNotFound) {
		return User{}, fmt.Errorf("store: update profile: %w", err)
	}
	return u, err
}

// SetUsername changes the username; ErrUsernameTaken when another user of
// the tenant holds it.
func (s *Store) SetUsername(ctx context.Context, tenantID string, id int64, name string) (User, error) {
	u, err := scanUser(s.pool.QueryRow(ctx, `
		UPDATE users SET username = $3, updated_at = now()
		WHERE tenant_id = $1 AND id = $2
		RETURNING `+userColumns,
		tenantID, id, name))
	var pgErr *pgconn.PgError
	switch {
	case errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "users_tenant_username_key":
		return User{}, ErrUsernameTaken
	case err != nil && !errors.Is(err, ErrNotFound):
		return User{}, fmt.Errorf("store: set username: %w", err)
	}
	return u, err
}
