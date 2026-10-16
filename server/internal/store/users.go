package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"

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
	// DeletionRequestedAt starts the deletion grace period (nil when the
	// account is not waiting for deletion); DeletionReason is then "user"
	// or "inactive".
	DeletionRequestedAt *time.Time
	DeletionReason      string
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

// IdPProfile carries the IdP claims used to create or refresh a user.
type IdPProfile struct {
	Sub               string
	PreferredUsername string
	Name              string
	Email             IdPEmail
	// EmailUnknown is set when the IdP's answer did not include the email
	// claims (an ID token without them while userinfo was unavailable): the
	// stored email is then kept instead of being cleared.
	EmailUnknown bool
}

// idpName is the IdP display name cleaned like the name of a new account,
// or "" when the IdP has none.
func (p IdPProfile) idpName() string {
	if strings.IndexFunc(p.Name, func(r rune) bool { return !unicode.IsSpace(r) && !unicode.IsControl(r) }) < 0 {
		return ""
	}
	return profile.InitialName(p.Name, "", "")
}

// fallbackName is the name a new account gets when the IdP reports no
// display name: the one derived from preferred_username.
func (p IdPProfile) fallbackName() string {
	return profile.InitialName("", p.PreferredUsername, profile.UsernameBase(p.PreferredUsername))
}

const userColumns = `id, tenant_id, coalesce(idp_sub, ''), username, name, bio, coalesce(email, ''), email_verified, created_at, updated_at,
	deletion_requested_at, coalesce(deletion_reason, '')`

// qualifiedUserColumns is userColumns for statements that join users (as u)
// with another relation.
const qualifiedUserColumns = `u.id, u.tenant_id, coalesce(u.idp_sub, ''), u.username, u.name, u.bio, coalesce(u.email, ''), u.email_verified, u.created_at, u.updated_at,
	u.deletion_requested_at, coalesce(u.deletion_reason, '')`

func scanUser(row pgx.Row) (User, error) {
	var u User
	err := row.Scan(&u.ID, &u.TenantID, &u.IdPSub, &u.Username, &u.Name, &u.Bio, &u.Email, &u.EmailVerified, &u.CreatedAt, &u.UpdatedAt,
		&u.DeletionRequestedAt, &u.DeletionReason)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrNotFound
	}
	return u, err
}

// UpsertIdPUser returns the user of (tenantID, profile.Sub), creating it on
// the first sign-in. A new user takes its username from preferred_username
// (digits appended on conflict) and its name from the profile. An existing
// user gets its email refreshed (kept when p.EmailUnknown) and the IdP
// display name only while its name is still the fallback taken from the
// username; a name the user chose is never overwritten.
func (s *Store) UpsertIdPUser(ctx context.Context, tenantID string, p IdPProfile) (User, error) {
	return s.UpsertIdPUserAdmitting(ctx, tenantID, p, nil)
}

// ErrSignupLimited: the sign-in would create a new user and admitNew
// refused it.
var ErrSignupLimited = errors.New("store: too many new users")

// UpsertIdPUserAdmitting is UpsertIdPUser that asks admitNew (when not
// nil) before creating a user; a refusal returns ErrSignupLimited and
// existing users are unaffected.
func (s *Store) UpsertIdPUserAdmitting(ctx context.Context, tenantID string, p IdPProfile, admitNew func() bool) (User, error) {
	if u, err := refreshIdPUser(ctx, s.pool, tenantID, p); !errors.Is(err, ErrNotFound) {
		return u, err
	}
	if admitNew != nil && !admitNew() {
		return User{}, ErrSignupLimited
	}
	email, verified := p.Email.stored()
	base := profile.UsernameBase(p.PreferredUsername)
	name := profile.InitialName(p.Name, p.PreferredUsername, base)
	for attempt := range maxUsernameAttempts {
		id, err := NextUserID(ctx, s.pool)
		if err != nil {
			return User{}, err
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
		if u, err := refreshIdPUser(ctx, s.pool, tenantID, p); !errors.Is(err, ErrNotFound) {
			return u, err
		}
	}
	return User{}, fmt.Errorf("store: no free username for base %q after %d attempts", base, maxUsernameAttempts)
}

type queryRower interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// NextUserID issues the id of a new user (accounts and bots alike).
func NextUserID(ctx context.Context, db queryRower) (int64, error) {
	var local int64
	if err := db.QueryRow(ctx, `SELECT nextval('user_local_id_seq')`).Scan(&local); err != nil {
		return 0, fmt.Errorf("store: next user id: %w", err)
	}
	id, err := ids.MakeSharded(userShard, local)
	if err != nil {
		return 0, fmt.Errorf("store: user id: %w", err)
	}
	return id, nil
}

// refreshIdPUser applies what the IdP reports to the existing user of
// (tenantID, p.Sub): the email state (unless p.EmailUnknown) and the display
// name while the stored name is still the username fallback (equal to the
// username, or to the name derived from preferred_username). ErrNotFound
// when there is no such user.
func refreshIdPUser(ctx context.Context, db queryRower, tenantID string, p IdPProfile) (User, error) {
	email, verified := p.Email.stored()
	u, err := scanUser(db.QueryRow(ctx, `
		WITH next AS (
			SELECT id,
				CASE WHEN $5 THEN email ELSE $3 END AS email,
				CASE WHEN $5 THEN email_verified ELSE $4 END AS email_verified,
				CASE WHEN $6 <> '' AND (name = username OR name = $7) THEN $6 ELSE name END AS name
			FROM users WHERE tenant_id = $1 AND idp_sub = $2
		)
		UPDATE users u SET email = next.email, email_verified = next.email_verified, name = next.name,
			updated_at = CASE WHEN u.email IS DISTINCT FROM next.email OR u.email_verified <> next.email_verified
				OR u.name <> next.name THEN now() ELSE u.updated_at END
		FROM next WHERE u.id = next.id
		RETURNING `+qualifiedUserColumns,
		tenantID, p.Sub, email, verified, p.EmailUnknown, p.idpName(), p.fallbackName()))
	if err != nil && !errors.Is(err, ErrNotFound) {
		return User{}, fmt.Errorf("store: refresh user from IdP: %w", err)
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
