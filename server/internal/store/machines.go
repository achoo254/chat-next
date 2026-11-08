package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// Limits of the machine directory (ADR 0013).
const (
	// InstallCodeTTL is how long an install code can be redeemed.
	InstallCodeTTL = 10 * time.Minute
	// MaxLiveInstallCodes bounds a user's unused, unexpired install codes.
	MaxLiveInstallCodes = 5
	// MaxMachines bounds a user's machines that are not revoked.
	MaxMachines = 20
	// MaxMachineNameLen is the longest machine name, in characters.
	MaxMachineNameLen = 64
	// MachineKeyLen is the length of an X25519 public key.
	MachineKeyLen = 32
)

// Machine directory errors.
var (
	// ErrTooManyInstallCodes: the user holds MaxLiveInstallCodes codes.
	ErrTooManyInstallCodes = errors.New("store: too many live install codes")
	// ErrInstallCodeInvalid: the code is unknown, expired or used, or its
	// owner's account was erased.
	ErrInstallCodeInvalid = errors.New("store: install code invalid")
	// ErrTooManyMachines: the code's owner has MaxMachines machines.
	ErrTooManyMachines = errors.New("store: too many machines")
)

// Machine is a row of the machine directory, without its secret.
type Machine struct {
	ID            int64
	TenantID      string
	UserID        int64
	Name          string
	OS            string
	Arch          string
	AgentVersion  string
	ClaudeVersion string
	PublicKey     []byte
	TunnelURL     string
	CreatedAt     time.Time
	LastSeenAt    time.Time
	// Revoked: the user removed the machine; only its heartbeat still
	// authenticates, to be told so.
	Revoked bool
}

// NewMachine is what chat-agent reports when it registers.
type NewMachine struct {
	Name         string
	OS           string
	Arch         string
	AgentVersion string
	PublicKey    []byte
}

const machineColumns = `m.id, m.tenant_id, m.user_id, m.name, m.os, m.arch, m.agent_version, m.claude_version,
	m.public_key, m.tunnel_url, m.created_at, m.last_seen_at, m.revoked_at IS NOT NULL`

func scanMachine(row pgx.Row) (Machine, error) {
	var m Machine
	err := row.Scan(&m.ID, &m.TenantID, &m.UserID, &m.Name, &m.OS, &m.Arch, &m.AgentVersion, &m.ClaudeVersion,
		&m.PublicKey, &m.TunnelURL, &m.CreatedAt, &m.LastSeenAt, &m.Revoked)
	if errors.Is(err, pgx.ErrNoRows) {
		return Machine{}, ErrNotFound
	}
	return m, err
}

// CleanMachineName trims name and reports whether it is a valid machine
// name: 1 to MaxMachineNameLen characters of valid UTF-8 without control
// characters.
func CleanMachineName(name string) (string, bool) {
	name = strings.TrimSpace(name)
	if name == "" || !utf8.ValidString(name) || utf8.RuneCountInString(name) > MaxMachineNameLen {
		return "", false
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return "", false
		}
	}
	return name, true
}

// newMachineToken returns n random bytes as base64url without padding, and
// the SHA-256 hash stored in its place.
func newMachineToken(n int) (string, []byte, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", nil, fmt.Errorf("store: random token: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(b)
	return token, machineTokenHash(token), nil
}

func machineTokenHash(token string) []byte {
	h := sha256.Sum256([]byte(token))
	return h[:]
}

// CreateInstallCode stores a new install code of the user (128 random bits,
// valid for InstallCodeTTL) and returns it with its expiry. The user's used
// and expired codes are deleted on the way.
func (s *Store) CreateInstallCode(ctx context.Context, tenantID string, userID int64) (string, time.Time, error) {
	code, hash, err := newMachineToken(16)
	if err != nil {
		return "", time.Time{}, err
	}
	var expires time.Time
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		// Serializes the user's code creations, so the limit holds.
		if _, err := tx.Exec(ctx, `SELECT 1 FROM users WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, userID, tenantID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			DELETE FROM machine_install_codes WHERE tenant_id = $1 AND user_id = $2 AND (used_at IS NOT NULL OR expires_at <= now())`,
			tenantID, userID); err != nil {
			return err
		}
		var live int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM machine_install_codes WHERE tenant_id = $1 AND user_id = $2`,
			tenantID, userID).Scan(&live); err != nil {
			return err
		}
		if live >= MaxLiveInstallCodes {
			return ErrTooManyInstallCodes
		}
		return tx.QueryRow(ctx, `
			INSERT INTO machine_install_codes (code_hash, tenant_id, user_id, expires_at)
			VALUES ($1, $2, $3, now() + $4::interval) RETURNING expires_at`,
			hash, tenantID, userID, InstallCodeTTL).Scan(&expires)
	})
	if errors.Is(err, ErrTooManyInstallCodes) {
		return "", time.Time{}, err
	}
	if err != nil {
		return "", time.Time{}, fmt.Errorf("store: create install code: %w", err)
	}
	return code, expires, nil
}

// RegisterMachine redeems an install code for a new machine of the code's
// owner and returns the machine and its secret (256 random bits; only its
// hash is stored). The fields must be validated by the caller. It fails
// with ErrInstallCodeInvalid or ErrTooManyMachines; on ErrTooManyMachines
// the code stays usable.
func (s *Store) RegisterMachine(ctx context.Context, tenantID, code string, n NewMachine) (Machine, string, error) {
	secret, secretHash, err := newMachineToken(32)
	if err != nil {
		return Machine{}, "", err
	}
	var m Machine
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		var userID int64
		err := tx.QueryRow(ctx, `
			UPDATE machine_install_codes c SET used_at = now()
			FROM users u
			WHERE c.code_hash = $1 AND c.tenant_id = $2 AND c.used_at IS NULL AND c.expires_at > now()
				AND u.id = c.user_id AND u.deleted_at IS NULL
			RETURNING c.user_id`, machineTokenHash(code), tenantID).Scan(&userID)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrInstallCodeInvalid
		}
		if err != nil {
			return err
		}
		// The code row is locked by the update; the user row serializes the
		// user's registrations, so the limit holds.
		if _, err := tx.Exec(ctx, `SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, userID); err != nil {
			return err
		}
		var count int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM machines WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
			tenantID, userID).Scan(&count); err != nil {
			return err
		}
		if count >= MaxMachines {
			return ErrTooManyMachines
		}
		m, err = scanMachine(tx.QueryRow(ctx, `
			INSERT INTO machines AS m (tenant_id, user_id, name, os, arch, agent_version, public_key, secret_hash)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			RETURNING `+machineColumns,
			tenantID, userID, n.Name, n.OS, n.Arch, n.AgentVersion, n.PublicKey, secretHash))
		return err
	})
	if errors.Is(err, ErrInstallCodeInvalid) || errors.Is(err, ErrTooManyMachines) {
		return Machine{}, "", err
	}
	if err != nil {
		return Machine{}, "", fmt.Errorf("store: register machine: %w", err)
	}
	return m, secret, nil
}

// AuthenticateMachine returns the machine whose secret is secret, revoked or
// not; ErrNotFound when there is none or its owner's account was erased.
func (s *Store) AuthenticateMachine(ctx context.Context, tenantID, secret string) (Machine, error) {
	m, err := scanMachine(s.pool.QueryRow(ctx, `
		SELECT `+machineColumns+` FROM machines m JOIN users u ON u.id = m.user_id
		WHERE m.tenant_id = $1 AND m.secret_hash = $2 AND u.deleted_at IS NULL`,
		tenantID, machineTokenHash(secret)))
	if err != nil && !errors.Is(err, ErrNotFound) {
		return Machine{}, fmt.Errorf("store: authenticate machine: %w", err)
	}
	return m, err
}

// MachineHeartbeat records that a machine that is not revoked is alive, with
// what it reported, and returns the device keys revoked for it.
// ErrNotFound when the machine is revoked (or unknown).
func (s *Store) MachineHeartbeat(ctx context.Context, tenantID string, machineID int64, tunnelURL, agentVersion, claudeVersion string) ([][]byte, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE machines SET tunnel_url = $3, agent_version = $4, claude_version = $5, last_seen_at = now()
		WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL`,
		machineID, tenantID, tunnelURL, agentVersion, claudeVersion)
	if err != nil {
		return nil, fmt.Errorf("store: machine heartbeat: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return nil, ErrNotFound
	}
	rows, err := s.pool.Query(ctx, `
		SELECT device_public_key FROM machine_revoked_devices WHERE machine_id = $1 AND tenant_id = $2 ORDER BY revoked_at, device_public_key`,
		machineID, tenantID)
	if err != nil {
		return nil, fmt.Errorf("store: revoked devices: %w", err)
	}
	keys, err := pgx.CollectRows(rows, pgx.RowTo[[]byte])
	if err != nil {
		return nil, fmt.Errorf("store: revoked devices: %w", err)
	}
	return keys, nil
}

// ListMachines returns the user's machines that are not revoked, oldest
// first.
func (s *Store) ListMachines(ctx context.Context, tenantID string, userID int64) ([]Machine, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+machineColumns+` FROM machines m
		WHERE m.tenant_id = $1 AND m.user_id = $2 AND m.revoked_at IS NULL ORDER BY m.created_at, m.id`,
		tenantID, userID)
	if err != nil {
		return nil, fmt.Errorf("store: list machines: %w", err)
	}
	defer rows.Close()
	var out []Machine
	for rows.Next() {
		m, err := scanMachine(rows)
		if err != nil {
			return nil, fmt.Errorf("store: list machines: %w", err)
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list machines: %w", err)
	}
	return out, nil
}

// RenameMachine renames one of the user's machines that is not revoked
// (ErrNotFound otherwise); the name must be clean (CleanMachineName).
func (s *Store) RenameMachine(ctx context.Context, tenantID string, userID, machineID int64, name string) (Machine, error) {
	m, err := scanMachine(s.pool.QueryRow(ctx, `
		UPDATE machines m SET name = $4
		WHERE m.id = $1 AND m.tenant_id = $2 AND m.user_id = $3 AND m.revoked_at IS NULL
		RETURNING `+machineColumns, machineID, tenantID, userID, name))
	if err != nil && !errors.Is(err, ErrNotFound) {
		return Machine{}, fmt.Errorf("store: rename machine: %w", err)
	}
	return m, err
}

// RevokeMachine revokes one of the user's machines (ErrNotFound when it is
// not the user's or already revoked) and forgets its tunnel address.
func (s *Store) RevokeMachine(ctx context.Context, tenantID string, userID, machineID int64) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE machines SET revoked_at = now(), tunnel_url = ''
		WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND revoked_at IS NULL`,
		machineID, tenantID, userID)
	if err != nil {
		return fmt.Errorf("store: revoke machine: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// RevokeMachineDevice adds a device key (MachineKeyLen bytes) to the revoked
// list of one of the user's machines that is not revoked (ErrNotFound
// otherwise). Revoking a key twice is not an error.
func (s *Store) RevokeMachineDevice(ctx context.Context, tenantID string, userID, machineID int64, deviceKey []byte) error {
	var found bool
	err := s.pool.QueryRow(ctx, `
		WITH m AS (
			SELECT id, tenant_id FROM machines WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND revoked_at IS NULL
		), ins AS (
			INSERT INTO machine_revoked_devices (machine_id, tenant_id, device_public_key)
			SELECT id, tenant_id, $4 FROM m
			ON CONFLICT (machine_id, device_public_key) DO NOTHING
		)
		SELECT EXISTS (SELECT 1 FROM m)`, machineID, tenantID, userID, deviceKey).Scan(&found)
	if err != nil {
		return fmt.Errorf("store: revoke machine device: %w", err)
	}
	if !found {
		return ErrNotFound
	}
	return nil
}
