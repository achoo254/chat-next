package store_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"strings"
	"testing"

	"app.local/server/internal/store"
)

// machineKey is a distinct 32-byte machine key per n.
func machineKey(n byte) []byte { return bytes.Repeat([]byte{n}, 32) }

func newMachineInput(name string, key byte) store.NewMachine {
	return store.NewMachine{Name: name, OS: "darwin", Arch: "arm64", AgentVersion: "3.0.0", PublicKey: machineKey(key), GrantID: "grant-" + name}
}

// legacyMachine inserts a machine as an install code made it: unclaimed.
func legacyMachine(t *testing.T, s *store.Store, userID int64, secret string, key byte) int64 {
	t.Helper()
	hash := sha256.Sum256([]byte(secret))
	var id int64
	if err := s.Pool().QueryRow(context.Background(), `
		INSERT INTO machines (tenant_id, user_id, name, os, arch, agent_version, public_key, secret_hash)
		VALUES ($1, $2, 'old', 'win32', 'x64', '0.2.4', $3, $4) RETURNING id`,
		tenant, userID, machineKey(key), hash[:]).Scan(&id); err != nil {
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
	if _, _, err := s.RegisterMachine(ctx, "other", u.ID, newMachineInput("x", 7)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("user of another tenant: %v", err)
	}
	m, secret, err := s.RegisterMachine(ctx, tenant, u.ID, newMachineInput("Mac mini", 7))
	if err != nil {
		t.Fatal(err)
	}
	if m.UserID != u.ID || m.Name != "Mac mini" || m.OS != "darwin" || m.Arch != "arm64" || m.Revoked || !m.Claimed || len(secret) != 43 {
		t.Fatalf("machine %+v secret %q", m, secret)
	}
	var stored []byte
	var grant string
	if err := s.Pool().QueryRow(ctx, `SELECT secret_hash, idp_grant_id FROM machines WHERE id = $1`, m.ID).Scan(&stored, &grant); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(stored, []byte(secret)) || len(stored) != 32 {
		t.Fatal("the secret is stored in clear")
	}
	if grant != "grant-Mac mini" {
		t.Fatalf("grant %q", grant)
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
			tenant, u.ID, machineKey(byte(100+i)), bytes.Repeat([]byte{byte(i + 1)}, 32)); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := s.RegisterMachine(ctx, tenant, u.ID, newMachineInput("one too many", 8)); !errors.Is(err, store.ErrTooManyMachines) {
		t.Fatalf("over the machine limit: %v", err)
	}
	// Taking a machine back is not a new machine: the limit does not apply.
	if again, _, err := s.RegisterMachine(ctx, tenant, u.ID, newMachineInput("again", 7)); err != nil || again.ID != m.ID {
		t.Fatalf("registering a live key again at the limit: %+v %v", again, err)
	}
	if err := s.RevokeMachine(ctx, tenant, u.ID, m.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.RegisterMachine(ctx, tenant, u.ID, newMachineInput("replacement", 8)); err != nil {
		t.Fatalf("after revoking one: %v", err)
	}

	if _, err := s.Pool().Exec(ctx, `UPDATE users SET deleted_at = now() WHERE id = $1`, u.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.RegisterMachine(ctx, tenant, u.ID, newMachineInput("x", 9)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("erased user: %v", err)
	}
}

// Registering the same key again takes the live row back with a new secret;
// a removed machine is never brought back.
func TestRegisterMachineAgain(t *testing.T) {
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
	first, oldSecret, err := s.RegisterMachine(ctx, tenant, u.ID, newMachineInput("Mac mini", 7))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.RenameMachine(ctx, tenant, u.ID, first.ID, "Máy ở nhà"); err != nil {
		t.Fatal(err)
	}
	in := newMachineInput("hostname", 7)
	in.AgentVersion, in.GrantID = "3.0.1", "grant-2"
	again, newSecret, err := s.RegisterMachine(ctx, tenant, u.ID, in)
	if err != nil {
		t.Fatal(err)
	}
	if again.ID != first.ID || again.Name != "Máy ở nhà" || again.AgentVersion != "3.0.1" || newSecret == oldSecret {
		t.Fatalf("taken back %+v (secret changed %v)", again, newSecret != oldSecret)
	}
	if _, err := s.AuthenticateMachine(ctx, tenant, oldSecret); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("the old secret still works: %v", err)
	}
	var grant string
	if err := s.Pool().QueryRow(ctx, `SELECT idp_grant_id FROM machines WHERE id = $1`, first.ID).Scan(&grant); err != nil || grant != "grant-2" {
		t.Fatalf("grant %q %v", grant, err)
	}
	// The same key of another account is another machine.
	theirs, _, err := s.RegisterMachine(ctx, tenant, other.ID, newMachineInput("theirs", 7))
	if err != nil || theirs.ID == first.ID {
		t.Fatalf("another account's machine %+v %v", theirs, err)
	}

	if err := s.RevokeMachine(ctx, tenant, u.ID, first.ID); err != nil {
		t.Fatal(err)
	}
	back, _, err := s.RegisterMachine(ctx, tenant, u.ID, newMachineInput("Mac mini", 7))
	if err != nil || back.ID == first.ID || back.Revoked {
		t.Fatalf("after removal: %+v %v", back, err)
	}
	if got, err := s.AuthenticateMachine(ctx, tenant, newSecret); err != nil || !got.Revoked {
		t.Fatalf("the removed row came back: %+v %v", got, err)
	}

	// A machine of the install-code era becomes claimed, keeping its row.
	legacy := legacyMachine(t, s, u.ID, strings.Repeat("s", 43), 9)
	claimed, _, err := s.RegisterMachine(ctx, tenant, u.ID, newMachineInput("x", 9))
	if err != nil || claimed.ID != legacy || !claimed.Claimed {
		t.Fatalf("legacy machine %+v %v", claimed, err)
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
	register := func(name string, key byte) (store.Machine, string) {
		t.Helper()
		m, secret, err := s.RegisterMachine(ctx, tenant, u.ID, newMachineInput(name, key))
		if err != nil {
			t.Fatal(err)
		}
		return m, secret
	}
	mac, macSecret := register("Mac mini", 7)
	pc, _ := register("PC", 8)

	devices, err := s.MachineHeartbeat(ctx, tenant, mac.ID, "wss://dat.tunnel.hoandat.com", "3.0.0", nil)
	if err != nil || len(devices) != 0 {
		t.Fatalf("heartbeat: %v %v", devices, err)
	}
	list, err := s.ListMachines(ctx, tenant, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 || list[0].ID != mac.ID || list[0].TunnelURL != "wss://dat.tunnel.hoandat.com" ||
		list[0].AgentVersion != "3.0.0" || list[1].ID != pc.ID {
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
	if _, err := s.MachineHeartbeat(ctx, tenant, mac.ID, "", "3.0.0", nil); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("heartbeat of a revoked machine: %v", err)
	}
	if _, err := s.RenameMachine(ctx, tenant, u.ID, mac.ID, "x"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("rename a revoked machine: %v", err)
	}
}

// The grant of a removed machine is pending until the IdP revoked it; a
// machine that registered with another grant since is not marked by an
// older answer.
func TestGrantRevocations(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	u, err := s.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_1", PreferredUsername: "dat"})
	if err != nil {
		t.Fatal(err)
	}
	mac, _, err := s.RegisterMachine(ctx, tenant, u.ID, newMachineInput("mac", 7))
	if err != nil {
		t.Fatal(err)
	}
	noGrant := newMachineInput("pc", 8)
	noGrant.GrantID = ""
	pc, _, err := s.RegisterMachine(ctx, tenant, u.ID, noGrant)
	if err != nil {
		t.Fatal(err)
	}
	if list, err := s.PendingGrantRevocations(ctx, tenant, 10); err != nil || len(list) != 0 {
		t.Fatalf("pending before removal: %+v %v", list, err)
	}
	for _, id := range []int64{mac.ID, pc.ID} {
		if err := s.RevokeMachine(ctx, tenant, u.ID, id); err != nil {
			t.Fatal(err)
		}
	}
	list, err := s.PendingGrantRevocations(ctx, tenant, 10)
	want := store.GrantRevocation{MachineID: mac.ID, OwnerSub: "acc_1", GrantID: "grant-mac"}
	if err != nil || len(list) != 1 || list[0] != want {
		t.Fatalf("pending %+v %v", list, err)
	}
	if err := s.MarkGrantRevoked(ctx, tenant, mac.ID, "another-grant"); err != nil {
		t.Fatal(err)
	}
	if list, _ := s.PendingGrantRevocations(ctx, tenant, 10); len(list) != 1 {
		t.Fatalf("marked by another grant: %+v", list)
	}
	if err := s.MarkGrantRevoked(ctx, tenant, mac.ID, "grant-mac"); err != nil {
		t.Fatal(err)
	}
	if list, _ := s.PendingGrantRevocations(ctx, tenant, 10); len(list) != 0 {
		t.Fatalf("still pending: %+v", list)
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

// A person whose tunelo registers a machine before they opened the chat gets
// a user with a placeholder profile; the first web sign-in fills it in as a
// new user's would be.
func TestPendingUserGetsItsProfileAtFirstSignIn(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	if _, err := s.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_other", PreferredUsername: "dat"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpsertPendingIdPUser(ctx, tenant, "acc_9", func() bool { return false }); !errors.Is(err, store.ErrSignupLimited) {
		t.Fatalf("refused admission: %v", err)
	}
	pending, err := s.UpsertPendingIdPUser(ctx, tenant, "acc_9", func() bool { return true })
	if err != nil || !pending.ProfilePending || pending.Username != "acc_9" || pending.Name != "acc_9" || pending.Email != "" {
		t.Fatalf("pending user %+v %v", pending, err)
	}
	again, err := s.UpsertPendingIdPUser(ctx, tenant, "acc_9", func() bool { t.Error("asked again"); return false })
	if err != nil || again.ID != pending.ID {
		t.Fatalf("second registration %+v %v", again, err)
	}

	done, err := s.UpsertIdPUser(ctx, tenant, store.IdPProfile{
		Sub: "acc_9", PreferredUsername: "dat", Name: "Đạt Trịnh", Email: store.IdPEmail{Email: "dat@example.com", Verified: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	if done.ID != pending.ID || done.ProfilePending || done.Username != "dat2" || done.Name != "Đạt Trịnh" || done.Email != "dat@example.com" {
		t.Fatalf("after the first sign-in %+v", done)
	}
	// Later sign-ins keep the username, as for any user.
	later, err := s.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_9", PreferredUsername: "other_name", Name: "Đạt Trịnh"})
	if err != nil || later.Username != "dat2" {
		t.Fatalf("later sign-in %+v %v", later, err)
	}

	// Without a name at the IdP, the name comes from preferred_username.
	if _, err := s.UpsertPendingIdPUser(ctx, tenant, "acc_10", nil); err != nil {
		t.Fatal(err)
	}
	named, err := s.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_10", PreferredUsername: "binh"})
	if err != nil || named.Username != "binh" || named.Name != "binh" || named.ProfilePending {
		t.Fatalf("no IdP name %+v %v", named, err)
	}
}
