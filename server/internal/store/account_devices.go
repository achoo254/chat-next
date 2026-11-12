package store

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Limits of the account's device keys (ADR 0013).
const (
	// MaxAccountDevices bounds the live device keys of an account.
	MaxAccountDevices = 50
	// maxListedDevices bounds ListAccountDevices (live ones always fit).
	maxListedDevices = 100
	// MaxConnectedDeviceKeys bounds the keys a heartbeat reports connected.
	MaxConnectedDeviceKeys = 50
)

// Account device errors.
var (
	// ErrDeviceRevoked: the key was revoked once and never comes back.
	ErrDeviceRevoked = errors.New("store: device key revoked")
	// ErrSessionDevicesRevoked: a key of this session was revoked.
	ErrSessionDevicesRevoked = errors.New("store: a device of this session was revoked")
	// ErrDeviceKeyInUse: another live session registered the key.
	ErrDeviceKeyInUse = errors.New("store: device key registered by another session")
	// ErrTooManyDevices: the account has MaxAccountDevices live keys.
	ErrTooManyDevices = errors.New("store: too many devices")
)

var devicePlatformRE = regexp.MustCompile(`^[a-z0-9-]{1,32}$`)

// AccountDevice is a device key of an account.
type AccountDevice struct {
	ID         int64
	PublicKey  []byte
	Name       string
	Platform   string
	CreatedAt  time.Time
	LastSeenAt time.Time
	// RevokedAt is zero for a live key.
	RevokedAt time.Time
	// SessionID is the session that registered the key; 0 once that
	// session row was deleted.
	SessionID int64
}

// NewAccountDevice is what a device registers; the key must be MachineKeyLen
// bytes, the name clean (CleanMachineName) and the platform clean
// (CleanDevicePlatform).
type NewAccountDevice struct {
	PublicKey []byte
	Name      string
	Platform  string
}

// CleanDevicePlatform trims platform and reports whether it is 1 to 32
// characters of a-z, 0-9 and -.
func CleanDevicePlatform(platform string) (string, bool) {
	platform = strings.TrimSpace(platform)
	return platform, devicePlatformRE.MatchString(platform)
}

const accountDeviceColumns = `d.id, d.public_key, d.name, d.platform, d.created_at, d.last_seen_at, d.revoked_at, coalesce(d.session_id, 0)`

func scanAccountDevice(row pgx.Row) (AccountDevice, error) {
	var d AccountDevice
	var revoked *time.Time
	err := row.Scan(&d.ID, &d.PublicKey, &d.Name, &d.Platform, &d.CreatedAt, &d.LastSeenAt, &revoked, &d.SessionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return AccountDevice{}, ErrNotFound
	}
	if revoked != nil {
		d.RevokedAt = *revoked
	}
	return d, err
}

func collectAccountDevices(rows pgx.Rows) ([]AccountDevice, error) {
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (AccountDevice, error) { return scanAccountDevice(row) })
}

// expireAccountDevices revokes the user's live keys whose session is no
// longer usable: expired, or its row deleted. Ended sessions revoke their
// keys at once (trigger user_sessions_ended_devices); an expiry has no
// event, so it is caught here, before every read of the keys.
func expireAccountDevices(ctx context.Context, tx pgx.Tx, tenantID string, userID int64) error {
	_, err := tx.Exec(ctx, `
		UPDATE account_devices d SET revoked_at = now()
		WHERE d.tenant_id = $1 AND d.user_id = $2 AND d.revoked_at IS NULL
			AND NOT EXISTS (SELECT 1 FROM user_sessions s WHERE s.id = d.session_id AND `+activeSession+`)`,
		tenantID, userID)
	if err != nil {
		return fmt.Errorf("store: expire devices: %w", err)
	}
	return nil
}

// RegisterAccountDevice adds a device key of the user bound to sessionID (an
// active session of the user; the caller's). created is false when this
// session had registered the key already: its name and platform are
// updated. ErrDeviceRevoked for a key revoked before, ErrSessionDevicesRevoked
// when a key of this session was revoked, ErrDeviceKeyInUse when another
// session holds the key, ErrTooManyDevices at the limit, ErrNotFound when
// the user is gone.
func (s *Store) RegisterAccountDevice(ctx context.Context, tenantID string, userID, sessionID int64, n NewAccountDevice) (dev AccountDevice, created bool, err error) {
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		// The user row serializes the user's registrations, so the limit holds.
		var live bool
		err := tx.QueryRow(ctx, `SELECT deleted_at IS NULL FROM users WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
			userID, tenantID).Scan(&live)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && !live) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if err := expireAccountDevices(ctx, tx, tenantID, userID); err != nil {
			return err
		}
		var sessionRevoked bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM account_devices WHERE session_id = $1 AND revoked_at IS NOT NULL)`,
			sessionID).Scan(&sessionRevoked); err != nil {
			return err
		}
		if sessionRevoked {
			return ErrSessionDevicesRevoked
		}
		existing, err := scanAccountDevice(tx.QueryRow(ctx, `
			SELECT `+accountDeviceColumns+` FROM account_devices d WHERE d.user_id = $1 AND d.public_key = $2 FOR UPDATE`,
			userID, n.PublicKey))
		switch {
		case err == nil && !existing.RevokedAt.IsZero():
			return ErrDeviceRevoked
		case err == nil && existing.SessionID != sessionID:
			return ErrDeviceKeyInUse
		case err == nil:
			dev, err = scanAccountDevice(tx.QueryRow(ctx, `
				UPDATE account_devices d SET name = $2, platform = $3, last_seen_at = now()
				WHERE d.id = $1 RETURNING `+accountDeviceColumns, existing.ID, n.Name, n.Platform))
			return err
		case !errors.Is(err, ErrNotFound):
			return err
		}
		var count int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM account_devices WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
			tenantID, userID).Scan(&count); err != nil {
			return err
		}
		if count >= MaxAccountDevices {
			return ErrTooManyDevices
		}
		dev, err = scanAccountDevice(tx.QueryRow(ctx, `
			INSERT INTO account_devices AS d (tenant_id, user_id, session_id, public_key, name, platform)
			VALUES ($1, $2, $3, $4, $5, $6)
			RETURNING `+accountDeviceColumns, tenantID, userID, sessionID, n.PublicKey, n.Name, n.Platform))
		created = err == nil
		return err
	})
	switch {
	case errors.Is(err, ErrNotFound), errors.Is(err, ErrDeviceRevoked), errors.Is(err, ErrSessionDevicesRevoked),
		errors.Is(err, ErrDeviceKeyInUse), errors.Is(err, ErrTooManyDevices):
		return AccountDevice{}, false, err
	case err != nil:
		return AccountDevice{}, false, fmt.Errorf("store: register device: %w", err)
	}
	return dev, created, nil
}

// ListAccountDevices returns the user's live keys, then the most recently
// revoked, newest first, at most 100 in all. Keys of expired sessions are
// revoked first.
func (s *Store) ListAccountDevices(ctx context.Context, tenantID string, userID int64) ([]AccountDevice, error) {
	var out []AccountDevice
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := expireAccountDevices(ctx, tx, tenantID, userID); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `
			SELECT `+accountDeviceColumns+` FROM account_devices d WHERE d.tenant_id = $1 AND d.user_id = $2
			ORDER BY (d.revoked_at IS NULL) DESC, coalesce(d.revoked_at, d.created_at) DESC, d.id DESC
			LIMIT $3`, tenantID, userID, maxListedDevices)
		if err != nil {
			return err
		}
		out, err = collectAccountDevices(rows)
		return err
	})
	if err != nil {
		return nil, fmt.Errorf("store: list devices: %w", err)
	}
	return out, nil
}

// RevokeAccountDevice revokes a key of the user (already revoked is fine) and
// returns the session that registered it (0 when its row is gone), for the
// caller to revoke. ErrNotFound when the user never registered the key.
func (s *Store) RevokeAccountDevice(ctx context.Context, tenantID string, userID int64, key []byte) (int64, error) {
	d, err := scanAccountDevice(s.pool.QueryRow(ctx, `
		UPDATE account_devices d SET revoked_at = coalesce(d.revoked_at, now())
		WHERE d.tenant_id = $1 AND d.user_id = $2 AND d.public_key = $3
		RETURNING `+accountDeviceColumns, tenantID, userID, key))
	if errors.Is(err, ErrNotFound) {
		return 0, err
	}
	if err != nil {
		return 0, fmt.Errorf("store: revoke device: %w", err)
	}
	return d.SessionID, nil
}

// trustedDevices returns the user's live keys with a usable session, oldest
// first, after revoking those whose session expired.
func trustedDevices(ctx context.Context, tx pgx.Tx, tenantID string, userID int64) ([]AccountDevice, error) {
	if err := expireAccountDevices(ctx, tx, tenantID, userID); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
		SELECT `+accountDeviceColumns+` FROM account_devices d
		WHERE d.tenant_id = $1 AND d.user_id = $2 AND d.revoked_at IS NULL
		ORDER BY d.created_at, d.id`, tenantID, userID)
	if err != nil {
		return nil, fmt.Errorf("store: trusted devices: %w", err)
	}
	list, err := collectAccountDevices(rows)
	if err != nil {
		return nil, fmt.Errorf("store: trusted devices: %w", err)
	}
	return list, nil
}
