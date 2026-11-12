package store_test

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"app.local/server/internal/store"
)

func agentUser(t *testing.T, s *store.Store, sub string) int64 {
	t.Helper()
	u, err := s.UpsertIdPUser(context.Background(), tenant, store.IdPProfile{Sub: sub, PreferredUsername: sub})
	if err != nil {
		t.Fatal(err)
	}
	return u.ID
}

func agentMachine(t *testing.T, s *store.Store, userID int64, key byte) int64 {
	t.Helper()
	in := newMachineInput("m")
	in.PublicKey = bytes.Repeat([]byte{key}, 32)
	m, _, err := s.RegisterMachine(context.Background(), tenant, userID, in)
	if err != nil {
		t.Fatal(err)
	}
	return m.ID
}

func TestAgentProjectNamesAndDirs(t *testing.T) {
	for name, want := range map[string]string{" app ": "app", "Dự án": "Dự án", strings.Repeat("x", 64): strings.Repeat("x", 64)} {
		if got, ok := store.CleanAgentProjectName(name); !ok || got != want {
			t.Errorf("CleanAgentProjectName(%q) = %q, %v", name, got, ok)
		}
	}
	for _, bad := range []string{"", "  ", strings.Repeat("x", 65), "a\nb", "a\x00b", "\xff"} {
		if _, ok := store.CleanAgentProjectName(bad); ok {
			t.Errorf("CleanAgentProjectName(%q) accepted", bad)
		}
	}
	for _, dir := range []string{"/", "/Users/dat/app", `C:\repos\app`, "c:/repos/app", `\\server\share\app`} {
		if !store.CleanAgentWorkspaceDir(dir) {
			t.Errorf("CleanAgentWorkspaceDir(%q) refused", dir)
		}
	}
	for _, dir := range []string{"", "app", "./app", "~/app", "C:", "C:app", `\\`, "/a\nb", "/a\x00b", "/" + strings.Repeat("a", 1024)} {
		if store.CleanAgentWorkspaceDir(dir) {
			t.Errorf("CleanAgentWorkspaceDir(%q) accepted", dir)
		}
	}
	if !store.CleanAgentWorkspaceBranch("") || !store.CleanAgentWorkspaceBranch("feat/x") || store.CleanAgentWorkspaceBranch("a\tb") ||
		store.CleanAgentWorkspaceBranch(strings.Repeat("b", 256)) {
		t.Error("CleanAgentWorkspaceBranch")
	}
}

func TestAgentProjects(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	me := agentUser(t, s, "acc_me")
	bob := agentUser(t, s, "acc_bob")
	mac := agentMachine(t, s, me, 1)
	bobMac := agentMachine(t, s, bob, 1) // the same key in another account

	empty, err := s.CreateAgentProject(ctx, tenant, me, "Notes", "")
	if err != nil || empty.GitRemote != "" || empty.Order != 1 {
		t.Fatalf("empty project: %+v %v", empty, err)
	}
	linked, err := s.CreateAgentProject(ctx, tenant, me, "chat-next", "github.com/achoo254/chat-next")
	if err != nil || linked.GitRemote != "github.com/achoo254/chat-next" || linked.Order != 2 {
		t.Fatalf("linked project: %+v %v", linked, err)
	}
	// One repository links one project of a user; empty remotes never clash;
	// another user links the same repository freely.
	if _, err := s.CreateAgentProject(ctx, tenant, me, "again", "github.com/achoo254/chat-next"); !errors.Is(err, store.ErrAgentProjectRemoteExists) {
		t.Fatalf("duplicate remote: %v", err)
	}
	if _, err := s.CreateAgentProject(ctx, tenant, me, "Notes 2", ""); err != nil {
		t.Fatalf("second empty project: %v", err)
	}
	bobProject, err := s.CreateAgentProject(ctx, tenant, bob, "chat-next", "github.com/achoo254/chat-next")
	if err != nil {
		t.Fatalf("same remote in another account: %v", err)
	}

	w, err := s.AttachAgentWorkspace(ctx, tenant, me, store.NewAgentWorkspace{
		ProjectID: linked.ID, MachineID: mac, Dir: "/Users/dat/chat-next", Branch: "main", Kind: store.AgentWorkspaceClone,
	})
	if err != nil || w.MachineID != mac || w.ProjectID != linked.ID || w.Kind != store.AgentWorkspaceClone || w.Branch != "main" {
		t.Fatalf("attach: %+v %v", w, err)
	}
	attach := func(user, project, machine int64, dir string) error {
		_, err := s.AttachAgentWorkspace(ctx, tenant, user, store.NewAgentWorkspace{
			ProjectID: project, MachineID: machine, Dir: dir, Kind: store.AgentWorkspaceFolder,
		})
		return err
	}
	// One folder of a machine is one workspace, whatever the project.
	if err := attach(me, empty.ID, mac, "/Users/dat/chat-next"); !errors.Is(err, store.ErrAgentWorkspaceExists) {
		t.Fatalf("same folder twice: %v", err)
	}
	// Another user's project or machine is not found.
	if err := attach(me, bobProject.ID, mac, "/x"); !errors.Is(err, store.ErrAgentProjectNotFound) {
		t.Fatalf("attach to another user's project: %v", err)
	}
	if err := attach(me, empty.ID, bobMac, "/x"); !errors.Is(err, store.ErrAgentMachineNotFound) {
		t.Fatalf("attach on another user's machine: %v", err)
	}
	if err := attach(bob, bobProject.ID, bobMac, "/Users/dat/chat-next"); err != nil {
		t.Fatalf("the same folder and key in another account: %v", err)
	}

	list, err := s.ListAgentProjects(ctx, tenant, me)
	if err != nil || len(list) != 3 || list[1].ID != linked.ID || len(list[1].Workspaces) != 1 || list[1].Workspaces[0].ID != w.ID ||
		len(list[0].Workspaces) != 0 {
		t.Fatalf("list: %+v %v", list, err)
	}

	// Another user can neither read nor change mine.
	if l, _ := s.ListAgentProjects(ctx, tenant, bob); len(l) != 1 || l[0].ID != bobProject.ID {
		t.Fatalf("bob's list: %+v", l)
	}
	if _, err := s.RenameAgentProject(ctx, tenant, bob, linked.ID, "mine"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("bob renames: %v", err)
	}
	if err := s.DeleteAgentProject(ctx, tenant, bob, linked.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("bob deletes: %v", err)
	}
	if err := s.DetachAgentWorkspace(ctx, tenant, bob, w.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("bob detaches: %v", err)
	}
	if _, err := s.MoveAgentWorkspace(ctx, tenant, bob, w.ID, bobProject.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("bob moves my workspace: %v", err)
	}
	if _, err := s.MoveAgentWorkspace(ctx, tenant, me, w.ID, bobProject.ID); !errors.Is(err, store.ErrAgentProjectNotFound) {
		t.Fatalf("move to bob's project: %v", err)
	}
	if l, err := s.ListAgentProjects(ctx, "other", me); err != nil || len(l) != 0 {
		t.Fatalf("another tenant lists %+v %v", l, err)
	}

	renamed, err := s.RenameAgentProject(ctx, tenant, me, linked.ID, "Chat")
	if err != nil || renamed.Name != "Chat" || len(renamed.Workspaces) != 1 {
		t.Fatalf("rename: %+v %v", renamed, err)
	}
	// Linking a repository later, changing it, a duplicate refused, unlinking; the workspaces stay.
	remote := func(v string) *string { return &v }
	if p, err := s.UpdateAgentProject(ctx, tenant, me, empty.ID, nil, remote("github.com/achoo254/notes")); err != nil || p.GitRemote != "github.com/achoo254/notes" || p.Name != "Notes" {
		t.Fatalf("link later: %+v %v", p, err)
	}
	if _, err := s.UpdateAgentProject(ctx, tenant, me, empty.ID, nil, remote("github.com/achoo254/chat-next")); !errors.Is(err, store.ErrAgentProjectRemoteExists) {
		t.Fatalf("link a repository another project links: %v", err)
	}
	if _, err := s.UpdateAgentProject(ctx, tenant, bob, empty.ID, nil, remote("")); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("bob unlinks mine: %v", err)
	}
	if p, err := s.UpdateAgentProject(ctx, tenant, me, linked.ID, remote("Chat 2"), remote("")); err != nil || p.GitRemote != "" || p.Name != "Chat 2" || len(p.Workspaces) != 1 {
		t.Fatalf("rename and unlink: %+v %v", p, err)
	}
	// Unlinked: the repository is free again, for another project.
	if p, err := s.UpdateAgentProject(ctx, tenant, me, empty.ID, nil, remote("github.com/achoo254/chat-next")); err != nil || p.GitRemote != "github.com/achoo254/chat-next" {
		t.Fatalf("relink: %+v %v", p, err)
	}
	moved, err := s.MoveAgentWorkspace(ctx, tenant, me, w.ID, empty.ID)
	if err != nil || moved.ProjectID != empty.ID || moved.MachineID != mac {
		t.Fatalf("move: %+v %v", moved, err)
	}

	// Deleting a project drops its workspace records only.
	if err := s.DeleteAgentProject(ctx, tenant, me, empty.ID); err != nil {
		t.Fatal(err)
	}
	var left int
	if err := s.Pool().QueryRow(ctx, `SELECT count(*) FROM agent_workspaces WHERE user_id = $1`, me).Scan(&left); err != nil || left != 0 {
		t.Fatalf("workspaces after deleting the project: %d %v", left, err)
	}
	if err := s.DeleteAgentProject(ctx, tenant, me, empty.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("delete twice: %v", err)
	}
	if err := s.DetachAgentWorkspace(ctx, tenant, me, w.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("detach a deleted workspace: %v", err)
	}
	if l, _ := s.ListAgentProjects(ctx, tenant, bob); len(l) != 1 || len(l[0].Workspaces) != 1 {
		t.Fatalf("bob's project changed: %+v", l)
	}
}

// A machine removed and added again (a new machines row, the same key)
// gets its workspaces back; while it is removed they stay, without machine.
func TestAgentWorkspaceSurvivesMachineReAdd(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	me := agentUser(t, s, "acc_me")
	first := agentMachine(t, s, me, 5)
	p, err := s.CreateAgentProject(ctx, tenant, me, "app", "")
	if err != nil {
		t.Fatal(err)
	}
	w, err := s.AttachAgentWorkspace(ctx, tenant, me, store.NewAgentWorkspace{ProjectID: p.ID, MachineID: first, Dir: "/app", Kind: store.AgentWorkspaceFolder})
	if err != nil {
		t.Fatal(err)
	}
	machineOf := func() int64 {
		t.Helper()
		l, err := s.ListAgentProjects(ctx, tenant, me)
		if err != nil || len(l) != 1 || len(l[0].Workspaces) != 1 || l[0].Workspaces[0].ID != w.ID {
			t.Fatalf("list: %+v %v", l, err)
		}
		return l[0].Workspaces[0].MachineID
	}
	if err := s.RevokeMachine(ctx, tenant, me, first); err != nil {
		t.Fatal(err)
	}
	if got := machineOf(); got != 0 {
		t.Fatalf("removed machine still named: %d", got)
	}
	if _, err := s.AttachAgentWorkspace(ctx, tenant, me, store.NewAgentWorkspace{ProjectID: p.ID, MachineID: first, Dir: "/b", Kind: store.AgentWorkspaceFolder}); !errors.Is(err, store.ErrAgentMachineNotFound) {
		t.Fatalf("attach on a removed machine: %v", err)
	}
	again := agentMachine(t, s, me, 5)
	if again == first {
		t.Fatal("adding again kept the machine id")
	}
	if got := machineOf(); got != again {
		t.Fatalf("machine after adding again: %d, want %d", got, again)
	}
	// Another machine never takes the workspace.
	other := agentMachine(t, s, me, 6)
	if got := machineOf(); got != again || got == other {
		t.Fatalf("machine after another was added: %d", got)
	}
}

func TestAgentProjectLimitsAndErasure(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	me := agentUser(t, s, "acc_me")
	mac := agentMachine(t, s, me, 3)
	if _, err := s.Pool().Exec(ctx, `
		INSERT INTO agent_projects (tenant_id, user_id, name, sort_order)
		SELECT $1, $2, 'p' || g, g FROM generate_series(1, $3::int) g`, tenant, me, store.MaxAgentProjects); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateAgentProject(ctx, tenant, me, "one too many", ""); !errors.Is(err, store.ErrTooManyAgentProjects) {
		t.Fatalf("over the project limit: %v", err)
	}
	var project int64
	if err := s.Pool().QueryRow(ctx, `SELECT min(id) FROM agent_projects WHERE user_id = $1`, me).Scan(&project); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Pool().Exec(ctx, `
		INSERT INTO agent_workspaces (project_id, tenant_id, user_id, machine_key, dir, kind)
		SELECT $1, $2, $3, $4, '/w' || g, 'folder' FROM generate_series(1, $5::int) g`,
		project, tenant, me, bytes.Repeat([]byte{3}, 32), store.MaxAgentWorkspaces); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AttachAgentWorkspace(ctx, tenant, me, store.NewAgentWorkspace{ProjectID: project, MachineID: mac, Dir: "/new", Kind: store.AgentWorkspaceFolder}); !errors.Is(err, store.ErrTooManyAgentWorkspaces) {
		t.Fatalf("over the workspace limit: %v", err)
	}

	// A workspace never belongs to a project of another owner, even written
	// by hand.
	bob := agentUser(t, s, "acc_bob")
	if _, err := s.Pool().Exec(ctx, `
		INSERT INTO agent_workspaces (project_id, tenant_id, user_id, machine_key, dir, kind) VALUES ($1, $2, $3, $4, '/x', 'folder')`,
		project, tenant, bob, bytes.Repeat([]byte{3}, 32)); err == nil {
		t.Fatal("a workspace of bob in my project was written")
	}

	// Erasing the account deletes its projects and workspaces.
	if _, err := s.Pool().Exec(ctx, `UPDATE users SET deleted_at = now() WHERE id = $1`, me); err != nil {
		t.Fatal(err)
	}
	var projects, workspaces int
	if err := s.Pool().QueryRow(ctx, `SELECT (SELECT count(*) FROM agent_projects WHERE user_id = $1), (SELECT count(*) FROM agent_workspaces WHERE user_id = $1)`,
		me).Scan(&projects, &workspaces); err != nil || projects != 0 || workspaces != 0 {
		t.Fatalf("after erasure: %d projects, %d workspaces, %v", projects, workspaces, err)
	}
	if _, err := s.CreateAgentProject(ctx, tenant, me, "x", ""); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("create for an erased user: %v", err)
	}
}

// The server keeps metadata only: the columns of the two tables are the
// documented fields, nothing that could hold a session or a file.
func TestAgentProjectsStoreMetadataOnly(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	rows, err := s.Pool().Query(ctx, `
		SELECT table_name || '.' || column_name FROM information_schema.columns
		WHERE table_name IN ('agent_projects', 'agent_workspaces') ORDER BY table_name, ordinal_position`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var got []string
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			t.Fatal(err)
		}
		got = append(got, c)
	}
	want := "agent_projects.id agent_projects.tenant_id agent_projects.user_id agent_projects.name agent_projects.git_remote " +
		"agent_projects.sort_order agent_projects.created_at agent_workspaces.id agent_workspaces.project_id " +
		"agent_workspaces.tenant_id agent_workspaces.user_id agent_workspaces.machine_key agent_workspaces.dir " +
		"agent_workspaces.branch agent_workspaces.kind agent_workspaces.created_at"
	if strings.Join(got, " ") != want {
		t.Fatalf("columns:\n%s\nwant:\n%s", strings.Join(got, " "), want)
	}
}
