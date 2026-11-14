package store_test

import (
	"context"
	"errors"
	"testing"

	"app.local/server/internal/store"
)

func detachedOf(t *testing.T, s *store.Store, user int64) []store.AgentDetachedFolder {
	t.Helper()
	list, err := s.ListAgentDetachedFolders(context.Background(), tenant, user)
	if err != nil {
		t.Fatal(err)
	}
	return list
}

// A folder the user dropped while its machine could not be told stays marked
// for every device of the user, only for them, and goes when the machine has
// dropped it, when it is recorded again, or with the machine.
func TestAgentDetachedFolders(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	me := agentUser(t, s, "acc_me")
	bob := agentUser(t, s, "acc_bob")
	mac := agentMachine(t, s, me, 1)
	bobMac := agentMachine(t, s, bob, 1) // the same key in another account

	if err := s.SetAgentFolderDetached(ctx, tenant, me, mac, "/w/gone", true); err != nil {
		t.Fatal(err)
	}
	// Marking twice changes nothing.
	if err := s.SetAgentFolderDetached(ctx, tenant, me, mac, "/w/gone", true); err != nil {
		t.Fatal(err)
	}
	if got := detachedOf(t, s, me); len(got) != 1 || got[0].MachineID != mac || got[0].Dir != "/w/gone" {
		t.Fatalf("marked: %+v", got)
	}
	if got := detachedOf(t, s, bob); len(got) != 0 {
		t.Fatalf("another account sees the mark: %+v", got)
	}

	// A machine of another account is not found, whatever its id; so is no machine at all.
	if err := s.SetAgentFolderDetached(ctx, tenant, me, bobMac, "/w/x", true); !errors.Is(err, store.ErrAgentMachineNotFound) {
		t.Fatalf("mark on bob's machine: %v", err)
	}
	if err := s.SetAgentFolderDetached(ctx, tenant, me, 999999, "/w/x", false); !errors.Is(err, store.ErrAgentMachineNotFound) {
		t.Fatalf("unmark on no machine: %v", err)
	}

	// Taking the mark off, and taking off one that is not there.
	if err := s.SetAgentFolderDetached(ctx, tenant, me, mac, "/w/gone", false); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAgentFolderDetached(ctx, tenant, me, mac, "/w/gone", false); err != nil {
		t.Fatal(err)
	}
	if got := detachedOf(t, s, me); len(got) != 0 {
		t.Fatalf("after unmarking: %+v", got)
	}

	// Recording the folder as a workspace again takes its mark off.
	p, err := s.CreateAgentProject(ctx, tenant, me, "app", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SetAgentFolderDetached(ctx, tenant, me, mac, "/w/back", true); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAgentFolderDetached(ctx, tenant, me, mac, "/w/other", true); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AttachAgentWorkspace(ctx, tenant, me, store.NewAgentWorkspace{ProjectID: p.ID, MachineID: mac, Dir: "/w/back", Kind: store.AgentWorkspaceFolder}); err != nil {
		t.Fatal(err)
	}
	if got := detachedOf(t, s, me); len(got) != 1 || got[0].Dir != "/w/other" {
		t.Fatalf("after recording the folder: %+v", got)
	}

	// With the machine removed the mark is not listed (the folder has nobody to be dropped from).
	if err := s.RevokeMachine(ctx, tenant, me, mac); err != nil {
		t.Fatal(err)
	}
	if got := detachedOf(t, s, me); len(got) != 0 {
		t.Fatalf("mark of a removed machine listed: %+v", got)
	}
	// Added again with the same key, the mark is back with the new machine.
	again := agentMachine(t, s, me, 1)
	if got := detachedOf(t, s, me); len(got) != 1 || got[0].MachineID != again || got[0].Dir != "/w/other" {
		t.Fatalf("after adding the machine again: %+v", got)
	}
}

func TestAgentDetachedFoldersLimitAndErasure(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	me := agentUser(t, s, "acc_me")
	mac := agentMachine(t, s, me, 2)
	if _, err := s.Pool().Exec(ctx, `
		INSERT INTO agent_detached_folders (tenant_id, user_id, machine_key, dir)
		SELECT $1, $2, $3, '/d' || g FROM generate_series(1, $4::int) g`,
		tenant, me, bytesOf(2, 32), store.MaxAgentDetachedFolders); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAgentFolderDetached(ctx, tenant, me, mac, "/one/too/many", true); !errors.Is(err, store.ErrTooManyDetachedFolders) {
		t.Fatalf("over the limit: %v", err)
	}
	// A mark already there is still accepted at the limit, and taking one off always works.
	if err := s.SetAgentFolderDetached(ctx, tenant, me, mac, "/d1", false); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAgentFolderDetached(ctx, tenant, me, mac, "/one/more", true); err != nil {
		t.Fatalf("under the limit again: %v", err)
	}

	// Erasing the account deletes its marks.
	if _, err := s.Pool().Exec(ctx, `UPDATE users SET deleted_at = now() WHERE id = $1`, me); err != nil {
		t.Fatal(err)
	}
	var marks int
	if err := s.Pool().QueryRow(ctx, `SELECT count(*) FROM agent_detached_folders WHERE user_id = $1`, me).Scan(&marks); err != nil || marks != 0 {
		t.Fatalf("after erasure: %d marks, %v", marks, err)
	}
}

func bytesOf(b byte, n int) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = b
	}
	return out
}
