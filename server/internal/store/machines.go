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

	"github.com/jackc/pgx/v5"
)

// Limits of the machine directory (ADR 0013).
const (
	// MaxMachines bounds a user's machines that are not revoked; the same
	// as the linked machines of a Localman account.
	MaxMachines = 20
	// MaxMachineNameLen is the longest machine name, in characters.
	MaxMachineNameLen = 64
	// MachineKeyLen is the length of an X25519 public key.
	MachineKeyLen = 32
)

// Machine directory errors.
var (
	// ErrTooManyMachines: the owner has MaxMachines machines.
	ErrTooManyMachines = errors.New("store: too many machines")
)

// Machine is a row of the machine directory, without its secret.
type Machine struct {
	ID           int64
	TenantID     string
	UserID       int64
	Name         string
	OS           string
	Arch         string
	AgentVersion string
	PublicKey    []byte
	TunnelURL    string
	CreatedAt    time.Time
	LastSeenAt   time.Time
	// Revoked: the user removed the machine; only its heartbeat still
	// authenticates, to be told so.
	Revoked bool
	// Claimed: tied to the owner's IdP account (registered with an access
	// token); only rows from the install-code era are unclaimed, and they
	// become claimed when tunelo registers the same key again.
	Claimed bool
}

// AuthenticatedMachine is the machine of a secret with its owner's IdP
// subject (users.idp_sub), which its tunnel check compares with.
type AuthenticatedMachine struct {
	Machine
	OwnerSub string
}

// NewMachine is what tunelo reports when it registers.
type NewMachine struct {
	Name         string
	OS           string
	Arch         string
	AgentVersion string
	PublicKey    []byte
	// GrantID is the IdP grant of the tunelo sign-in whose access token
	// registers the machine ("" when the token does not name it); removing
	// the machine revokes it.
	GrantID string
}

const machineColumns = `m.id, m.tenant_id, m.user_id, m.name, m.os, m.arch, m.agent_version,
	m.public_key, m.tunnel_url, m.created_at, m.last_seen_at, m.revoked_at IS NOT NULL, m.claimed_at IS NOT NULL`

func scanMachine(row pgx.Row) (Machine, error) {
	var m Machine
	err := row.Scan(&m.ID, &m.TenantID, &m.UserID, &m.Name, &m.OS, &m.Arch, &m.AgentVersion,
		&m.PublicKey, &m.TunnelURL, &m.CreatedAt, &m.LastSeenAt, &m.Revoked, &m.Claimed)
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
	if name == "" || !cleanText(name, MaxMachineNameLen) {
		return "", false
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

// RegisterMachine adds a claimed machine of the user (a live person; the
// caller resolved it from the access token), or takes back the user's live
// machine with the same public key: same id and name, the reported fields,
// the new grant and a new secret (the old one stops working). A revoked
// machine is never brought back; a new row is made. It returns the machine
// with its secret (256 random bits; only its hash is stored). The fields
// must be validated by the caller. ErrNotFound when the user is gone,
// ErrTooManyMachines at the limit.
func (s *Store) RegisterMachine(ctx context.Context, tenantID string, userID int64, n NewMachine) (Machine, string, error) {
	secret, secretHash, err := newMachineToken(32)
	if err != nil {
		return Machine{}, "", err
	}
	var m Machine
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		// The user row serializes the user's registrations, so the limit and
		// the one live row per key hold.
		var live bool
		err := tx.QueryRow(ctx, `SELECT deleted_at IS NULL FROM users WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
			userID, tenantID).Scan(&live)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && !live) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		m, err = scanMachine(tx.QueryRow(ctx, `
			UPDATE machines m SET os = $4, arch = $5, agent_version = $6, secret_hash = $7, idp_grant_id = $8,
				grant_revoked_at = NULL, claimed_at = coalesce(m.claimed_at, now()), last_seen_at = now()
			WHERE m.tenant_id = $1 AND m.user_id = $2 AND m.public_key = $3 AND m.revoked_at IS NULL
			RETURNING `+machineColumns,
			tenantID, userID, n.PublicKey, n.OS, n.Arch, n.AgentVersion, secretHash, n.GrantID))
		if !errors.Is(err, ErrNotFound) {
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
			INSERT INTO machines AS m (tenant_id, user_id, name, os, arch, agent_version, public_key, secret_hash, claimed_at, idp_grant_id)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9)
			RETURNING `+machineColumns,
			tenantID, userID, n.Name, n.OS, n.Arch, n.AgentVersion, n.PublicKey, secretHash, n.GrantID))
		return err
	})
	if errors.Is(err, ErrNotFound) || errors.Is(err, ErrTooManyMachines) {
		return Machine{}, "", err
	}
	if err != nil {
		return Machine{}, "", fmt.Errorf("store: register machine: %w", err)
	}
	return m, secret, nil
}

// AuthenticateMachine returns the machine whose secret is secret, revoked or
// not, with its owner's IdP subject; ErrNotFound when there is none or its
// owner's account was erased.
func (s *Store) AuthenticateMachine(ctx context.Context, tenantID, secret string) (AuthenticatedMachine, error) {
	var a AuthenticatedMachine
	var sub *string
	err := s.pool.QueryRow(ctx, `
		SELECT `+machineColumns+`, u.idp_sub FROM machines m JOIN users u ON u.id = m.user_id
		WHERE m.tenant_id = $1 AND m.secret_hash = $2 AND u.deleted_at IS NULL`,
		tenantID, machineTokenHash(secret)).Scan(&a.ID, &a.TenantID, &a.UserID, &a.Name, &a.OS, &a.Arch, &a.AgentVersion,
		&a.PublicKey, &a.TunnelURL, &a.CreatedAt, &a.LastSeenAt, &a.Revoked, &a.Claimed, &sub)
	if errors.Is(err, pgx.ErrNoRows) {
		return AuthenticatedMachine{}, ErrNotFound
	}
	if err != nil {
		return AuthenticatedMachine{}, fmt.Errorf("store: authenticate machine: %w", err)
	}
	if sub != nil {
		a.OwnerSub = *sub
	}
	return a, nil
}

// MachineHeartbeat records that a machine that is not revoked is alive, with
// what it reported, moves last_seen_at of the owner's devices connected to it
// (connected: at most MaxConnectedDeviceKeys keys) and returns the owner's
// trusted devices: live keys with a usable session, oldest first.
// ErrNotFound when the machine is revoked (or unknown).
func (s *Store) MachineHeartbeat(ctx context.Context, tenantID string, machineID int64, tunnelURL, agentVersion string,
	connected [][]byte) ([]AccountDevice, error) {
	var trusted []AccountDevice
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		var userID int64
		err := tx.QueryRow(ctx, `
			UPDATE machines SET tunnel_url = $3, agent_version = $4, last_seen_at = now()
			WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL
			RETURNING user_id`,
			machineID, tenantID, tunnelURL, agentVersion).Scan(&userID)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if len(connected) > 0 {
			if _, err := tx.Exec(ctx, `
				UPDATE account_devices SET last_seen_at = now()
				WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL AND public_key = ANY($3)`,
				tenantID, userID, connected); err != nil {
				return err
			}
		}
		trusted, err = trustedDevices(ctx, tx, tenantID, userID)
		return err
	})
	if errors.Is(err, ErrNotFound) {
		return nil, err
	}
	if err != nil {
		return nil, fmt.Errorf("store: machine heartbeat: %w", err)
	}
	return trusted, nil
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

// GrantRevocation is the IdP grant of a removed machine that is not known
// to be revoked yet.
type GrantRevocation struct {
	MachineID int64
	// OwnerSub is the owner's IdP subject; "" once the account was erased.
	OwnerSub string
	GrantID  string
}

// PendingGrantRevocations returns up to limit removed machines whose IdP
// grant is not revoked yet, the earliest removed first.
func (s *Store) PendingGrantRevocations(ctx context.Context, tenantID string, limit int) ([]GrantRevocation, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT m.id, coalesce(u.idp_sub, ''), m.idp_grant_id FROM machines m JOIN users u ON u.id = m.user_id
		WHERE m.tenant_id = $1 AND m.revoked_at IS NOT NULL AND m.idp_grant_id <> '' AND m.grant_revoked_at IS NULL
		ORDER BY m.revoked_at, m.id LIMIT $2`, tenantID, limit)
	if err != nil {
		return nil, fmt.Errorf("store: pending grant revocations: %w", err)
	}
	list, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (GrantRevocation, error) {
		var g GrantRevocation
		err := row.Scan(&g.MachineID, &g.OwnerSub, &g.GrantID)
		return g, err
	})
	if err != nil {
		return nil, fmt.Errorf("store: pending grant revocations: %w", err)
	}
	return list, nil
}

// MarkGrantRevoked records that the IdP revoked grantID of a removed
// machine. Nothing happens when the machine registered with another grant
// since.
func (s *Store) MarkGrantRevoked(ctx context.Context, tenantID string, machineID int64, grantID string) error {
	if _, err := s.pool.Exec(ctx, `
		UPDATE machines SET grant_revoked_at = now()
		WHERE id = $1 AND tenant_id = $2 AND idp_grant_id = $3 AND grant_revoked_at IS NULL`,
		machineID, tenantID, grantID); err != nil {
		return fmt.Errorf("store: mark grant revoked: %w", err)
	}
	return nil
}
