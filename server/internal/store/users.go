package store

import (
	"context"
	"errors"
	"fmt"
	"net/url"
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
	// DeletionRequestedAt is set once the account's erasure is queued (it
	// was deleted at the IdP, ADR 0016): the account is locked until the
	// erasure ends. Nil otherwise.
	DeletionRequestedAt *time.Time
	// PhotoID is the file_id of the profile photo ("" without one).
	PhotoID string
	// IdPPicture is the https URL of the IdP's profile picture ("" without
	// one); only ever shown to the user themself.
	IdPPicture string
	// ProfilePending: created by tunelo's machine registration with a
	// placeholder username and name, before the person opened the chat; not
	// findable until the first web sign-in fills in the profile.
	ProfilePending bool
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
	// Picture is the IdP's picture claim; PictureUnknown, like EmailUnknown,
	// keeps the stored picture when the answer said nothing about it.
	Picture        string
	PictureUnknown bool
}

// maxPictureLen bounds a stored picture URL (the column's CHECK).
const maxPictureLen = 2048

// idpPicture is the picture URL to store: an absolute https URL with a
// host, or nil (none, or one the app will not load).
func (p IdPProfile) idpPicture() *string {
	raw := strings.TrimSpace(p.Picture)
	if raw == "" || len(raw) > maxPictureLen {
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
		return nil
	}
	return &raw
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
	deletion_requested_at, coalesce((SELECT pf.public_id FROM files pf WHERE pf.id = photo_file_id), ''),
	coalesce(idp_picture, ''), profile_pending`

// qualifiedUserColumns is userColumns for statements that join users (as u)
// with another relation.
const qualifiedUserColumns = `u.id, u.tenant_id, coalesce(u.idp_sub, ''), u.username, u.name, u.bio, coalesce(u.email, ''), u.email_verified, u.created_at, u.updated_at,
	u.deletion_requested_at, coalesce((SELECT pf.public_id FROM files pf WHERE pf.id = u.photo_file_id), ''),
	coalesce(u.idp_picture, ''), u.profile_pending`

func scanUser(row pgx.Row) (User, error) {
	var u User
	err := row.Scan(&u.ID, &u.TenantID, &u.IdPSub, &u.Username, &u.Name, &u.Bio, &u.Email, &u.EmailVerified, &u.CreatedAt, &u.UpdatedAt,
		&u.DeletionRequestedAt, &u.PhotoID, &u.IdPPicture, &u.ProfilePending)
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
	u, err := refreshIdPUser(ctx, s.pool, tenantID, p)
	if err == nil && u.ProfilePending {
		return s.completeProfile(ctx, u, p)
	}
	if !errors.Is(err, ErrNotFound) {
		return u, err
	}
	if admitNew != nil && !admitNew() {
		return User{}, ErrSignupLimited
	}
	email, verified := p.Email.stored()
	base := profile.UsernameBase(p.PreferredUsername)
	name := profile.InitialName(p.Name, p.PreferredUsername, base)
	return s.insertIdPUser(ctx, tenantID, p.Sub, base, newUserFields{name: name, email: email, verified: verified, picture: p.idpPicture()},
		func() (User, error) { return refreshIdPUser(ctx, s.pool, tenantID, p) })
}

// newUserFields are the profile columns of a new IdP user.
type newUserFields struct {
	name     string
	email    *string
	verified bool
	picture  *string
	pending  bool
}

// insertIdPUser creates the user of sub with the first free username
// derived from base. On a clash, existing reports the user a concurrent
// sign-in created (ErrNotFound when the clash was the username).
func (s *Store) insertIdPUser(ctx context.Context, tenantID, sub, base string, f newUserFields, existing func() (User, error)) (User, error) {
	for attempt := range maxUsernameAttempts {
		id, err := NextUserID(ctx, s.pool)
		if err != nil {
			return User{}, err
		}
		// No conflict target: a clash on either unique key returns no row.
		u, err := scanUser(s.pool.QueryRow(ctx, `
			INSERT INTO users (id, tenant_id, idp_sub, username, name, email, email_verified, idp_picture, profile_pending)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			ON CONFLICT DO NOTHING
			RETURNING `+userColumns,
			id, tenantID, sub, profile.UsernameCandidate(base, attempt), f.name, f.email, f.verified, f.picture, f.pending))
		if err == nil {
			return u, nil
		}
		if !errors.Is(err, ErrNotFound) {
			return User{}, fmt.Errorf("store: insert user: %w", err)
		}
		// Either a concurrent sign-in created this account, or the username
		// is taken; the first case wins.
		if u, err := existing(); !errors.Is(err, ErrNotFound) {
			return u, err
		}
	}
	return User{}, fmt.Errorf("store: no free username for base %q after %d attempts", base, maxUsernameAttempts)
}

// UpsertPendingIdPUser returns the user of the IdP subject sub, creating
// it when the account never signed in to the chat: tunelo registers the
// person's machine with an access token that carries no name or email, so
// the user gets a placeholder username and name derived from sub and
// profile_pending, which keeps it out of username lookups and search until
// the first web sign-in fills in the profile (UpsertIdPUser). admitNew is
// asked before creating, as for a web sign-in (ErrSignupLimited when it
// refuses). An existing user is returned as is, erased or not.
func (s *Store) UpsertPendingIdPUser(ctx context.Context, tenantID, sub string, admitNew func() bool) (User, error) {
	byExactSub := func() (User, error) {
		u, err := scanUser(s.pool.QueryRow(ctx, `SELECT `+userColumns+` FROM users WHERE tenant_id = $1 AND idp_sub = $2`, tenantID, sub))
		if err != nil && !errors.Is(err, ErrNotFound) {
			return User{}, fmt.Errorf("store: user by IdP subject: %w", err)
		}
		return u, err
	}
	if u, err := byExactSub(); !errors.Is(err, ErrNotFound) {
		return u, err
	}
	if admitNew != nil && !admitNew() {
		return User{}, ErrSignupLimited
	}
	base := profile.UsernameBase(sub)
	return s.insertIdPUser(ctx, tenantID, sub, base, newUserFields{name: profile.InitialName("", "", base), pending: true}, byExactSub)
}

// completeProfile gives a pending user (UpsertPendingIdPUser) the username
// and name of the IdP profile at its first web sign-in, as a new user would
// get them, and clears profile_pending. A name the person already set is
// kept.
func (s *Store) completeProfile(ctx context.Context, u User, p IdPProfile) (User, error) {
	base := profile.UsernameBase(p.PreferredUsername)
	name := profile.InitialName(p.Name, p.PreferredUsername, base)
	for attempt := range maxUsernameAttempts {
		done, err := scanUser(s.pool.QueryRow(ctx, `
			UPDATE users SET username = $3, name = CASE WHEN name = username THEN $4 ELSE name END,
				profile_pending = false, updated_at = now()
			WHERE id = $1 AND tenant_id = $2 AND profile_pending
			RETURNING `+userColumns, u.ID, u.TenantID, profile.UsernameCandidate(base, attempt), name))
		var pgErr *pgconn.PgError
		switch {
		case err == nil:
			return done, nil
		case errors.Is(err, ErrNotFound):
			// A concurrent sign-in completed it.
			return s.UserByID(ctx, u.TenantID, u.ID)
		case errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "users_tenant_username_key":
			continue
		default:
			return User{}, fmt.Errorf("store: complete profile: %w", err)
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
// (tenantID, p.Sub): the email state (unless p.EmailUnknown), the picture
// (unless p.PictureUnknown) and the display name while the stored name is
// still the username fallback (equal to the username, or to the name
// derived from preferred_username). ErrNotFound when there is no such user.
func refreshIdPUser(ctx context.Context, db queryRower, tenantID string, p IdPProfile) (User, error) {
	email, verified := p.Email.stored()
	u, err := scanUser(db.QueryRow(ctx, `
		WITH next AS (
			SELECT id,
				CASE WHEN $5 THEN email ELSE $3 END AS email,
				CASE WHEN $5 THEN email_verified ELSE $4 END AS email_verified,
				CASE WHEN $6 <> '' AND (name = username OR name = $7) THEN $6 ELSE name END AS name,
				CASE WHEN $9 THEN idp_picture ELSE $8::text END AS idp_picture
			FROM users WHERE tenant_id = $1 AND idp_sub = $2
		)
		UPDATE users u SET email = next.email, email_verified = next.email_verified, name = next.name,
			idp_picture = next.idp_picture,
			updated_at = CASE WHEN u.email IS DISTINCT FROM next.email OR u.email_verified <> next.email_verified
				OR u.name <> next.name OR u.idp_picture IS DISTINCT FROM next.idp_picture THEN now() ELSE u.updated_at END
		FROM next WHERE u.id = next.id
		RETURNING `+qualifiedUserColumns,
		tenantID, p.Sub, email, verified, p.EmailUnknown, p.idpName(), p.fallbackName(), p.idpPicture(), p.PictureUnknown))
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

// UserByIdPSub returns the live (not erased) person of the tenant with this
// IdP subject; ErrNotFound when the account never signed in to the chat or
// was erased. Bots never match.
func (s *Store) UserByIdPSub(ctx context.Context, tenantID, sub string) (User, error) {
	u, err := scanUser(s.pool.QueryRow(ctx, `SELECT `+userColumns+` FROM users
		WHERE tenant_id = $1 AND idp_sub = $2 AND NOT is_bot AND deleted_at IS NULL`, tenantID, sub))
	if err != nil && !errors.Is(err, ErrNotFound) {
		return User{}, fmt.Errorf("store: user by IdP subject: %w", err)
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
