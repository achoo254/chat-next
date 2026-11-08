package store_test

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"app.local/server/internal/store"
)

func newMachineInput(name string) store.NewMachine {
	return store.NewMachine{Name: name, OS: "darwin", Arch: "arm64", AgentVersion: "0.1.0", PublicKey: bytes.Repeat([]byte{7}, 32)}
}

func TestInstallCodes(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	u, err := s.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_1", PreferredUsername: "dat"})
	if err != nil {
		t.Fatal(err)
	}
	before := time.Now()
	code, expires, err := s.CreateInstallCode(ctx, tenant, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(code) != 22 || expires.Before(before.Add(store.InstallCodeTTL-time.Minute)) || expires.After(before.Add(store.InstallCodeTTL+time.Minute)) {
		t.Fatalf("code %q expires %v", code, expires)
	}
	var stored []byte
	if err := s.Pool().QueryRow(ctx, `SELECT code_hash FROM machine_install_codes`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(stored, []byte(code)) || len(stored) != 32 {
		t.Fatal("the code is stored in clear")
	}
	for range store.MaxLiveInstallCodes - 1 {
		if _, _, err := s.CreateInstallCode(ctx, tenant, u.ID); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := s.CreateInstallCode(ctx, tenant, u.ID); !errors.Is(err, store.ErrTooManyInstallCodes) {
		t.Fatalf("code over the limit: %v", err)
	}
	// Used and expired codes free their place.
	if _, _, err := s.RegisterMachine(ctx, tenant, code, newMachineInput("Mac mini")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.CreateInstallCode(ctx, tenant, u.ID); err != nil {
		t.Fatalf("after one code was used: %v", err)
	}
	if _, err := s.Pool().Exec(ctx, `UPDATE machine_install_codes SET expires_at = now() - interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.CreateInstallCode(ctx, tenant, u.ID); err != nil {
		t.Fatalf("after the codes expired: %v", err)
	}
	var n int
	if err := s.Pool().QueryRow(ctx, `SELECT count(*) FROM machine_install_codes`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("%d codes kept", n)
	}
}

func TestRegisterMachine(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	u, err := s.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_1", PreferredUsername: "dat"})
	if err != nil {
		t.Fatal(err)
	}
	code, _, err := s.CreateInstallCode(ctx, tenant, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.RegisterMachine(ctx, tenant, "AAAAAAAAAAAAAAAAAAAAAA", newMachineInput("x")); !errors.Is(err, store.ErrInstallCodeInvalid) {
		t.Fatalf("unknown code: %v", err)
	}
	if _, _, err := s.RegisterMachine(ctx, "other", code, newMachineInput("x")); !errors.Is(err, store.ErrInstallCodeInvalid) {
		t.Fatalf("code of another tenant: %v", err)
	}
	m, secret, err := s.RegisterMachine(ctx, tenant, code, newMachineInput("Mac mini"))
	if err != nil {
		t.Fatal(err)
	}
	if m.UserID != u.ID || m.Name != "Mac mini" || m.OS != "darwin" || m.Arch != "arm64" || m.Revoked || len(secret) != 43 {
		t.Fatalf("machine %+v secret %q", m, secret)
	}
	if _, _, err := s.RegisterMachine(ctx, tenant, code, newMachineInput("again")); !errors.Is(err, store.ErrInstallCodeInvalid) {
		t.Fatalf("code used twice: %v", err)
	}
	expired, _, err := s.CreateInstallCode(ctx, tenant, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Pool().Exec(ctx, `UPDATE machine_install_codes SET expires_at = now() WHERE used_at IS NULL`); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.RegisterMachine(ctx, tenant, expired, newMachineInput("late")); !errors.Is(err, store.ErrInstallCodeInvalid) {
		t.Fatalf("expired code: %v", err)
	}

	got, err := s.AuthenticateMachine(ctx, tenant, secret)
	if err != nil || got.ID != m.ID {
		t.Fatalf("authenticate: %+v %v", got, err)
	}
	if _, err := s.AuthenticateMachine(ctx, tenant, secret+"x"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("wrong secret: %v", err)
	}
	if _, err := s.AuthenticateMachine(ctx, "other", secret); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("secret on another tenant: %v", err)
	}

	// The machine limit leaves the code usable.
	for i := range store.MaxMachines - 1 {
		if _, err := s.Pool().Exec(ctx, `
			INSERT INTO machines (tenant_id, user_id, name, os, arch, agent_version, public_key, secret_hash)
			VALUES ($1, $2, 'm', 'linux', 'x64', '0.1.0', $3, $4)`,
			tenant, u.ID, bytes.Repeat([]byte{1}, 32), bytes.Repeat([]byte{byte(i + 1)}, 32)); err != nil {
			t.Fatal(err)
		}
	}
	full, _, err := s.CreateInstallCode(ctx, tenant, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.RegisterMachine(ctx, tenant, full, newMachineInput("one too many")); !errors.Is(err, store.ErrTooManyMachines) {
		t.Fatalf("over the machine limit: %v", err)
	}
	if err := s.RevokeMachine(ctx, tenant, u.ID, m.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.RegisterMachine(ctx, tenant, full, newMachineInput("replacement")); err != nil {
		t.Fatalf("after revoking one: %v", err)
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
		code, _, err := s.CreateInstallCode(ctx, tenant, u.ID)
		if err != nil {
			t.Fatal(err)
		}
		m, secret, err := s.RegisterMachine(ctx, tenant, code, newMachineInput(name))
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
	if _, _, err := s.CreateInstallCode(ctx, tenant, u.ID); err != nil {
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
