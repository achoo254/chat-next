package store_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"strings"
	"testing"
	"time"

	"app.local/server/internal/store"
)

func newMachineInput(name string) store.NewMachine {
	return store.NewMachine{Name: name, OS: "darwin", Arch: "arm64", AgentVersion: "0.1.0", PublicKey: bytes.Repeat([]byte{7}, 32)}
}

// legacyMachine inserts a machine as an install code made it: unclaimed.
func legacyMachine(t *testing.T, s *store.Store, userID int64, secret string) int64 {
	t.Helper()
	hash := sha256.Sum256([]byte(secret))
	var id int64
	if err := s.Pool().QueryRow(context.Background(), `
		INSERT INTO machines (tenant_id, user_id, name, os, arch, agent_version, public_key, secret_hash)
		VALUES ($1, $2, 'old', 'win32', 'x64', '0.2.4', $3, $4) RETURNING id`,
		tenant, userID, bytes.Repeat([]byte{2}, 32), hash[:]).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestRegisterMachine(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	u, err := s.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_1", PreferredUsername: "dat"})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.RegisterMachine(ctx, "other", u.ID, newMachineInput("x")); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("user of another tenant: %v", err)
	}
	m, secret, err := s.RegisterMachine(ctx, tenant, u.ID, newMachineInput("Mac mini"))
	if err != nil {
		t.Fatal(err)
	}
	if m.UserID != u.ID || m.Name != "Mac mini" || m.OS != "darwin" || m.Arch != "arm64" || m.Revoked || !m.Claimed || len(secret) != 43 {
		t.Fatalf("machine %+v secret %q", m, secret)
	}
	var stored []byte
	if err := s.Pool().QueryRow(ctx, `SELECT secret_hash FROM machines WHERE id = $1`, m.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(stored, []byte(secret)) || len(stored) != 32 {
		t.Fatal("the secret is stored in clear")
	}

	got, err := s.AuthenticateMachine(ctx, tenant, secret)
	if err != nil || got.ID != m.ID || got.OwnerSub != "acc_1" || !got.Claimed {
		t.Fatalf("authenticate: %+v %v", got, err)
	}
	if _, err := s.AuthenticateMachine(ctx, tenant, secret+"x"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("wrong secret: %v", err)
	}
	if _, err := s.AuthenticateMachine(ctx, "other", secret); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("secret on another tenant: %v", err)
	}

	// The machine limit counts the machines that are not revoked.
	for i := range store.MaxMachines - 1 {
		if _, err := s.Pool().Exec(ctx, `
			INSERT INTO machines (tenant_id, user_id, name, os, arch, agent_version, public_key, secret_hash)
			VALUES ($1, $2, 'm', 'linux', 'x64', '0.1.0', $3, $4)`,
			tenant, u.ID, bytes.Repeat([]byte{1}, 32), bytes.Repeat([]byte{byte(i + 1)}, 32)); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := s.RegisterMachine(ctx, tenant, u.ID, newMachineInput("one too many")); !errors.Is(err, store.ErrTooManyMachines) {
		t.Fatalf("over the machine limit: %v", err)
	}
	if err := s.RevokeMachine(ctx, tenant, u.ID, m.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.RegisterMachine(ctx, tenant, u.ID, newMachineInput("replacement")); err != nil {
		t.Fatalf("after revoking one: %v", err)
	}

	if _, err := s.Pool().Exec(ctx, `UPDATE users SET deleted_at = now() WHERE id = $1`, u.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.RegisterMachine(ctx, tenant, u.ID, newMachineInput("x")); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("erased user: %v", err)
	}
}

func TestClaimMachine(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	u, err := s.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_1", PreferredUsername: "dat"})
	if err != nil {
		t.Fatal(err)
	}
	secret := strings.Repeat("s", 43)
	id := legacyMachine(t, s, u.ID, secret)
	got, err := s.AuthenticateMachine(ctx, tenant, secret)
	if err != nil || got.Claimed || got.OwnerSub != "acc_1" {
		t.Fatalf("machine of an install code: %+v %v", got, err)
	}
	if _, err := s.ClaimMachine(ctx, tenant, id, "acc_2"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("claim by another account: %v", err)
	}
	m, err := s.ClaimMachine(ctx, tenant, id, "acc_1")
	if err != nil || !m.Claimed || m.ID != id {
		t.Fatalf("claim: %+v %v", m, err)
	}
	var first time.Time
	if err := s.Pool().QueryRow(ctx, `SELECT claimed_at FROM machines WHERE id = $1`, id).Scan(&first); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ClaimMachine(ctx, tenant, id, "acc_1"); err != nil {
		t.Fatalf("claim again: %v", err)
	}
	var again time.Time
	if err := s.Pool().QueryRow(ctx, `SELECT claimed_at FROM machines WHERE id = $1`, id).Scan(&again); err != nil || !again.Equal(first) {
		t.Fatalf("claimed_at moved: %v -> %v (%v)", first, again, err)
	}
	if list, _ := s.ListMachines(ctx, tenant, u.ID); len(list) != 1 || !list[0].Claimed {
		t.Fatalf("list %+v", list)
	}
	if err := s.RevokeMachine(ctx, tenant, u.ID, id); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ClaimMachine(ctx, tenant, id, "acc_1"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("claim a revoked machine: %v", err)
	}
}

func TestMachineDirectory(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	u, err := s.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_1", PreferredUsername: "dat"})
	if err != nil {
		t.Fatal(err)
	}
	other, err := s.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_2", PreferredUsername: "binh"})
	if err != nil {
		t.Fatal(err)
	}
	register := func(name string) (store.Machine, string) {
		t.Helper()
		m, secret, err := s.RegisterMachine(ctx, tenant, u.ID, newMachineInput(name))
		if err != nil {
			t.Fatal(err)
		}
		return m, secret
	}
	mac, macSecret := register("Mac mini")
	pc, _ := register("PC")

	keys, err := s.MachineHeartbeat(ctx, tenant, mac.ID, "wss://dat.tunnel.hoandat.com", "0.2.0", "2.1.319 (Claude Code)")
	if err != nil || len(keys) != 0 {
		t.Fatalf("heartbeat: %v %v", keys, err)
	}
	list, err := s.ListMachines(ctx, tenant, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 || list[0].ID != mac.ID || list[0].TunnelURL != "wss://dat.tunnel.hoandat.com" ||
		list[0].AgentVersion != "0.2.0" || list[0].ClaudeVersion != "2.1.319 (Claude Code)" || list[1].ID != pc.ID {
		t.Fatalf("list %+v", list)
	}
	if list, _ := s.ListMachines(ctx, tenant, other.ID); len(list) != 0 {
		t.Fatalf("another user sees %+v", list)
	}

	if _, err := s.RenameMachine(ctx, tenant, other.ID, mac.ID, "mine"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("rename by another user: %v", err)
	}
	if renamed, err := s.RenameMachine(ctx, tenant, u.ID, mac.ID, "Máy ở nhà"); err != nil || renamed.Name != "Máy ở nhà" {
		t.Fatalf("rename: %+v %v", renamed, err)
	}

	phone := bytes.Repeat([]byte{3}, 32)
	if err := s.RevokeMachineDevice(ctx, tenant, other.ID, mac.ID, phone); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("revoke device by another user: %v", err)
	}
	for range 2 {
		if err := s.RevokeMachineDevice(ctx, tenant, u.ID, mac.ID, phone); err != nil {
			t.Fatal(err)
		}
	}
	keys, err = s.MachineHeartbeat(ctx, tenant, mac.ID, "", "0.2.0", "")
	if err != nil || len(keys) != 1 || !bytes.Equal(keys[0], phone) {
		t.Fatalf("revoked keys %x %v", keys, err)
	}
	if keys, _ := s.MachineHeartbeat(ctx, tenant, pc.ID, "", "0.2.0", ""); len(keys) != 0 {
		t.Fatalf("the other machine got %x", keys)
	}

	if err := s.RevokeMachine(ctx, tenant, other.ID, mac.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("revoke by another user: %v", err)
	}
	if err := s.RevokeMachine(ctx, tenant, u.ID, mac.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.RevokeMachine(ctx, tenant, u.ID, mac.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("revoked twice: %v", err)
	}
	if list, _ := s.ListMachines(ctx, tenant, u.ID); len(list) != 1 || list[0].ID != pc.ID {
		t.Fatalf("list after revoking: %+v", list)
	}
	// The revoked machine still authenticates, to learn it was revoked, but
	// its heartbeat records nothing.
	got, err := s.AuthenticateMachine(ctx, tenant, macSecret)
	if err != nil || !got.Revoked {
		t.Fatalf("revoked machine: %+v %v", got, err)
	}
	if _, err := s.MachineHeartbeat(ctx, tenant, mac.ID, "", "0.2.0", ""); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("heartbeat of a revoked machine: %v", err)
	}
	if _, err := s.RenameMachine(ctx, tenant, u.ID, mac.ID, "x"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("rename a revoked machine: %v", err)
	}

	// Erasing the account deletes its machines and codes.
	if _, err := s.Pool().Exec(ctx, `
		INSERT INTO machine_install_codes (code_hash, tenant_id, user_id, expires_at)
		VALUES ($1, $2, $3, now() + interval '10 minutes')`, bytes.Repeat([]byte{8}, 32), tenant, u.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Pool().Exec(ctx, `UPDATE users SET deleted_at = now() WHERE id = $1`, u.ID); err != nil {
		t.Fatal(err)
	}
	var machines, codes int
	if err := s.Pool().QueryRow(ctx, `SELECT (SELECT count(*) FROM machines), (SELECT count(*) FROM machine_install_codes)`).Scan(&machines, &codes); err != nil {
		t.Fatal(err)
	}
	if machines != 0 || codes != 0 {
		t.Fatalf("after erasure: %d machines, %d codes", machines, codes)
	}
}

func TestCleanMachineName(t *testing.T) {
	for in, want := range map[string]string{
		"  Mac mini ":                         "Mac mini",
		"Máy ở nhà":                           "Máy ở nhà",
		"":                                    "",
		"   ":                                 "",
		"a\nb":                                "",
		string([]byte{0xff}):                  "",
		string(bytes.Repeat([]byte("ổ"), 64)): string(bytes.Repeat([]byte("ổ"), 64)),
		string(bytes.Repeat([]byte("a"), 65)): "",
	} {
		got, ok := store.CleanMachineName(in)
		if got != want || ok != (want != "") {
			t.Errorf("CleanMachineName(%q) = %q, %v", in, got, ok)
		}
	}
}
