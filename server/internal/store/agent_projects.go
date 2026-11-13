package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Limits of the AI Agent projects (AgentProjectsService).
const (
	MaxAgentProjects      = 200
	MaxAgentWorkspaces    = 1000
	MaxAgentProjectName   = 64
	MaxAgentWorkspaceDir  = 1024
	MaxAgentWorkspaceRef  = 255
	agentProjectsRemoteIx = "agent_projects_remote_key"
	agentWorkspacesDirKey = "agent_workspaces_dir_key"
)

// Workspace kinds, as stored.
const (
	AgentWorkspaceClone    = "clone"
	AgentWorkspaceWorktree = "worktree"
	AgentWorkspaceFolder   = "folder"
)

// AI Agent project errors. ErrNotFound stands for the project or workspace
// a call is about when it is not the caller's; ErrAgentProjectNotFound for
// the target project of AttachAgentWorkspace and MoveAgentWorkspace.
var (
	ErrAgentProjectRemoteExists = errors.New("store: a project links this repository already")
	ErrAgentWorkspaceExists     = errors.New("store: the folder is a workspace already")
	ErrAgentProjectNotFound     = errors.New("store: project not found")
	ErrAgentMachineNotFound     = errors.New("store: machine not found")
	ErrTooManyAgentProjects     = errors.New("store: too many projects")
	ErrTooManyAgentWorkspaces   = errors.New("store: too many workspaces")
)

// AgentProject is a project of the AI Agent with its workspaces.
type AgentProject struct {
	ID int64
	// Name is clean (CleanAgentProjectName).
	Name string
	// GitRemote is the canonical key of the linked repository
	// (gitremote.Canonical); empty when the project links none.
	GitRemote  string
	Order      int32
	CreatedAt  time.Time
	Workspaces []AgentWorkspace
}

// AgentWorkspace is a folder of one of the owner's machines in a project.
type AgentWorkspace struct {
	ID        int64
	ProjectID int64
	// MachineID is the owner's live machine with the workspace's machine
	// key (the newest seen when several share it); 0 while none has it.
	MachineID int64
	Dir       string
	Branch    string
	Kind      string
	CreatedAt time.Time
}

// NewAgentWorkspace is a folder to attach; the fields must be validated by
// the caller (CleanAgentWorkspaceDir, CleanAgentWorkspaceBranch, a kind
// constant).
type NewAgentWorkspace struct {
	ProjectID int64
	MachineID int64
	Dir       string
	Branch    string
	Kind      string
}

// CleanAgentProjectName trims name and reports whether it is a valid
// project name: 1 to MaxAgentProjectName characters of valid UTF-8 without
// control characters.
func CleanAgentProjectName(name string) (string, bool) {
	name = strings.TrimSpace(name)
	if name == "" || !cleanText(name, MaxAgentProjectName) {
		return "", false
	}
	return name, true
}

// CleanAgentWorkspaceDir reports whether dir is an absolute path of a
// machine ("/…", "C:\…" or "C:/…", "\\server\share…") of at most
// MaxAgentWorkspaceDir characters without control characters. The path is
// kept as the machine reports it.
func CleanAgentWorkspaceDir(dir string) bool {
	if !cleanText(dir, MaxAgentWorkspaceDir) {
		return false
	}
	switch {
	case strings.HasPrefix(dir, `\\`):
		return len(dir) > 2
	case strings.HasPrefix(dir, "/"):
		return true
	default:
		return len(dir) >= 3 && isASCIILetter(dir[0]) && dir[1] == ':' && (dir[2] == '\\' || dir[2] == '/')
	}
}

// CleanAgentWorkspaceBranch reports whether branch is a valid branch label:
// at most MaxAgentWorkspaceRef characters without control characters
// ("" passes).
func CleanAgentWorkspaceBranch(branch string) bool {
	return cleanText(branch, MaxAgentWorkspaceRef)
}

// cleanText: valid UTF-8 of at most maxLen characters without control
// characters.
func cleanText(s string, maxLen int) bool {
	return utf8.ValidString(s) && utf8.RuneCountInString(s) <= maxLen && !strings.ContainsFunc(s, unicode.IsControl)
}

func isASCIILetter(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
}

// workspaceColumns resolve the machine of a workspace among the owner's
// machines that are not revoked, by its key.
const workspaceColumns = `w.id, w.project_id, coalesce((
		SELECT m.id FROM machines m
		WHERE m.tenant_id = w.tenant_id AND m.user_id = w.user_id AND m.public_key = w.machine_key AND m.revoked_at IS NULL
		ORDER BY m.last_seen_at DESC, m.id DESC LIMIT 1), 0),
	w.dir, w.branch, w.kind, w.created_at`

func scanWorkspace(row pgx.Row) (AgentWorkspace, error) {
	var w AgentWorkspace
	err := row.Scan(&w.ID, &w.ProjectID, &w.MachineID, &w.Dir, &w.Branch, &w.Kind, &w.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return AgentWorkspace{}, ErrNotFound
	}
	return w, err
}

const projectColumns = `p.id, p.name, coalesce(p.git_remote, ''), p.sort_order, p.created_at`

func scanProject(row pgx.Row) (AgentProject, error) {
	var p AgentProject
	err := row.Scan(&p.ID, &p.Name, &p.GitRemote, &p.Order, &p.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return AgentProject{}, ErrNotFound
	}
	return p, err
}

// isUnique reports a unique violation of constraint (or unique index).
func isUnique(err error, constraint string) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == constraint
}

// lockLiveUser locks the user row (serializing the user's changes, so the
// limits hold) and fails with ErrNotFound for a missing or erased user.
func lockLiveUser(ctx context.Context, tx pgx.Tx, tenantID string, userID int64) error {
	var live bool
	err := tx.QueryRow(ctx, `SELECT deleted_at IS NULL FROM users WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
		userID, tenantID).Scan(&live)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !live) {
		return ErrNotFound
	}
	return err
}

// ListAgentProjects returns the user's projects in order with their
// workspaces, oldest first.
func (s *Store) ListAgentProjects(ctx context.Context, tenantID string, userID int64) ([]AgentProject, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+projectColumns+` FROM agent_projects p
		WHERE p.tenant_id = $1 AND p.user_id = $2 ORDER BY p.sort_order, p.id`, tenantID, userID)
	if err != nil {
		return nil, fmt.Errorf("store: list agent projects: %w", err)
	}
	projects, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (AgentProject, error) { return scanProject(r) })
	if err != nil {
		return nil, fmt.Errorf("store: list agent projects: %w", err)
	}
	if len(projects) == 0 {
		return projects, nil
	}
	rows, err = s.pool.Query(ctx, `
		SELECT `+workspaceColumns+` FROM agent_workspaces w
		WHERE w.tenant_id = $1 AND w.user_id = $2 ORDER BY w.created_at, w.id`, tenantID, userID)
	if err != nil {
		return nil, fmt.Errorf("store: list agent workspaces: %w", err)
	}
	workspaces, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (AgentWorkspace, error) { return scanWorkspace(r) })
	if err != nil {
		return nil, fmt.Errorf("store: list agent workspaces: %w", err)
	}
	index := make(map[int64]int, len(projects))
	for i, p := range projects {
		index[p.ID] = i
	}
	for _, w := range workspaces {
		if i, ok := index[w.ProjectID]; ok {
			projects[i].Workspaces = append(projects[i].Workspaces, w)
		}
	}
	return projects, nil
}

// CreateAgentProject adds a project of the user, last in order; gitRemote
// is a canonical key or empty. ErrNotFound when the user is gone,
// ErrAgentProjectRemoteExists when another project links gitRemote,
// ErrTooManyAgentProjects at the limit.
func (s *Store) CreateAgentProject(ctx context.Context, tenantID string, userID int64, name, gitRemote string) (AgentProject, error) {
	var p AgentProject
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := lockLiveUser(ctx, tx, tenantID, userID); err != nil {
			return err
		}
		var count int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM agent_projects WHERE tenant_id = $1 AND user_id = $2`,
			tenantID, userID).Scan(&count); err != nil {
			return err
		}
		if count >= MaxAgentProjects {
			return ErrTooManyAgentProjects
		}
		var remote *string
		if gitRemote != "" {
			remote = &gitRemote
		}
		var err error
		p, err = scanProject(tx.QueryRow(ctx, `
			INSERT INTO agent_projects AS p (tenant_id, user_id, name, git_remote, sort_order)
			VALUES ($1, $2, $3, $4, (SELECT coalesce(max(sort_order), 0) + 1 FROM agent_projects WHERE tenant_id = $1 AND user_id = $2))
			RETURNING `+projectColumns, tenantID, userID, name, remote))
		return err
	})
	switch {
	case errors.Is(err, ErrNotFound), errors.Is(err, ErrTooManyAgentProjects):
		return AgentProject{}, err
	case isUnique(err, agentProjectsRemoteIx):
		return AgentProject{}, ErrAgentProjectRemoteExists
	case err != nil:
		return AgentProject{}, fmt.Errorf("store: create agent project: %w", err)
	}
	return p, nil
}

// RenameAgentProject renames one of the user's projects (ErrNotFound
// otherwise) and returns it with its workspaces; the name must be clean.
func (s *Store) RenameAgentProject(ctx context.Context, tenantID string, userID, projectID int64, name string) (AgentProject, error) {
	return s.UpdateAgentProject(ctx, tenantID, userID, projectID, &name, nil)
}

// UpdateAgentProject changes one of the user's projects (ErrNotFound
// otherwise): its name when name is set (clean), the repository it links
// when gitRemote is set (a canonical key, or "" to unlink). It returns the
// project with its workspaces; ErrAgentProjectRemoteExists when another
// project of the user links that repository. The workspaces stay.
func (s *Store) UpdateAgentProject(ctx context.Context, tenantID string, userID, projectID int64, name, gitRemote *string) (AgentProject, error) {
	var remote *string
	if gitRemote != nil && *gitRemote != "" {
		remote = gitRemote
	}
	p, err := scanProject(s.pool.QueryRow(ctx, `
		UPDATE agent_projects p SET name = coalesce($4, p.name), git_remote = CASE WHEN $5 THEN $6 ELSE p.git_remote END
		WHERE p.id = $1 AND p.tenant_id = $2 AND p.user_id = $3
		RETURNING `+projectColumns, projectID, tenantID, userID, name, gitRemote != nil, remote))
	switch {
	case errors.Is(err, ErrNotFound):
		return AgentProject{}, err
	case isUnique(err, agentProjectsRemoteIx):
		return AgentProject{}, ErrAgentProjectRemoteExists
	case err != nil:
		return AgentProject{}, fmt.Errorf("store: update agent project: %w", err)
	}
	rows, err := s.pool.Query(ctx, `
		SELECT `+workspaceColumns+` FROM agent_workspaces w
		WHERE w.project_id = $1 AND w.tenant_id = $2 AND w.user_id = $3 ORDER BY w.created_at, w.id`,
		projectID, tenantID, userID)
	if err != nil {
		return AgentProject{}, fmt.Errorf("store: update agent project: %w", err)
	}
	p.Workspaces, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (AgentWorkspace, error) { return scanWorkspace(r) })
	if err != nil {
		return AgentProject{}, fmt.Errorf("store: update agent project: %w", err)
	}
	return p, nil
}

// DeleteAgentProject deletes one of the user's projects with its workspace
// records (ErrNotFound when it is not the user's).
func (s *Store) DeleteAgentProject(ctx context.Context, tenantID string, userID, projectID int64) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM agent_projects WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
		projectID, tenantID, userID)
	if err != nil {
		return fmt.Errorf("store: delete agent project: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ReorderAgentProjects puts the user's projects in the order of ids: those
// first, then the rest in their order before (a project made meanwhile on
// another device is not lost to a list that does not name it). ids must be
// distinct and every one the user's project, else ErrNotFound and nothing
// changes.
func (s *Store) ReorderAgentProjects(ctx context.Context, tenantID string, userID int64, ids []int64) error {
	seen := make(map[int64]bool, len(ids))
	for _, id := range ids {
		if seen[id] {
			return ErrNotFound
		}
		seen[id] = true
	}
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := lockLiveUser(ctx, tx, tenantID, userID); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `
			UPDATE agent_projects p SET sort_order = o.ord
			FROM unnest($3::bigint[]) WITH ORDINALITY AS o(id, ord)
			WHERE p.id = o.id AND p.tenant_id = $1 AND p.user_id = $2`, tenantID, userID, ids)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != int64(len(ids)) {
			return ErrNotFound
		}
		_, err = tx.Exec(ctx, `
			WITH rest AS (
				SELECT id, row_number() OVER (ORDER BY sort_order, id) AS rn FROM agent_projects
				WHERE tenant_id = $1 AND user_id = $2 AND NOT (id = ANY($3::bigint[]))
			)
			UPDATE agent_projects p SET sort_order = $4 + rest.rn FROM rest WHERE p.id = rest.id`, tenantID, userID, ids, len(ids))
		return err
	})
	switch {
	case errors.Is(err, ErrNotFound):
		return ErrNotFound
	case err != nil:
		return fmt.Errorf("store: reorder agent projects: %w", err)
	}
	return nil
}

// AttachAgentWorkspace records a folder of one of the user's machines (not
// revoked) as a workspace of one of the user's projects. ErrNotFound when
// the user is gone, ErrAgentProjectNotFound for the project,
// ErrAgentMachineNotFound for the machine,
// ErrAgentWorkspaceExists when the folder of that machine is a workspace
// already, ErrTooManyAgentWorkspaces at the limit.
func (s *Store) AttachAgentWorkspace(ctx context.Context, tenantID string, userID int64, n NewAgentWorkspace) (AgentWorkspace, error) {
	var w AgentWorkspace
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := lockLiveUser(ctx, tx, tenantID, userID); err != nil {
			return err
		}
		var found bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM agent_projects WHERE id = $1 AND tenant_id = $2 AND user_id = $3)`,
			n.ProjectID, tenantID, userID).Scan(&found); err != nil {
			return err
		}
		if !found {
			return ErrAgentProjectNotFound
		}
		var key []byte
		err := tx.QueryRow(ctx, `SELECT public_key FROM machines WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND revoked_at IS NULL`,
			n.MachineID, tenantID, userID).Scan(&key)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrAgentMachineNotFound
		}
		if err != nil {
			return err
		}
		var count int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM agent_workspaces WHERE tenant_id = $1 AND user_id = $2`,
			tenantID, userID).Scan(&count); err != nil {
			return err
		}
		if count >= MaxAgentWorkspaces {
			return ErrTooManyAgentWorkspaces
		}
		w, err = scanWorkspace(tx.QueryRow(ctx, `
			INSERT INTO agent_workspaces AS w (project_id, tenant_id, user_id, machine_key, dir, branch, kind)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			RETURNING `+workspaceColumns, n.ProjectID, tenantID, userID, key, n.Dir, n.Branch, n.Kind))
		return err
	})
	switch {
	case errors.Is(err, ErrNotFound), errors.Is(err, ErrAgentProjectNotFound), errors.Is(err, ErrAgentMachineNotFound),
		errors.Is(err, ErrTooManyAgentWorkspaces):
		return AgentWorkspace{}, err
	case isUnique(err, agentWorkspacesDirKey):
		return AgentWorkspace{}, ErrAgentWorkspaceExists
	case err != nil:
		return AgentWorkspace{}, fmt.Errorf("store: attach agent workspace: %w", err)
	}
	return w, nil
}

// DetachAgentWorkspace drops one of the user's workspace records
// (ErrNotFound when it is not the user's).
func (s *Store) DetachAgentWorkspace(ctx context.Context, tenantID string, userID, workspaceID int64) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM agent_workspaces WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
		workspaceID, tenantID, userID)
	if err != nil {
		return fmt.Errorf("store: detach agent workspace: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// MoveAgentWorkspace moves one of the user's workspaces to another of the
// user's projects. ErrNotFound for the workspace, ErrAgentProjectNotFound
// for the project.
func (s *Store) MoveAgentWorkspace(ctx context.Context, tenantID string, userID, workspaceID, projectID int64) (AgentWorkspace, error) {
	w, err := scanWorkspace(s.pool.QueryRow(ctx, `
		WITH target AS (
			SELECT id FROM agent_projects WHERE id = $4 AND tenant_id = $2 AND user_id = $3
		)
		UPDATE agent_workspaces w SET project_id = (SELECT id FROM target)
		WHERE w.id = $1 AND w.tenant_id = $2 AND w.user_id = $3 AND EXISTS (SELECT 1 FROM target)
		RETURNING `+workspaceColumns, workspaceID, tenantID, userID, projectID))
	if errors.Is(err, ErrNotFound) {
		// Tell which of the two is missing.
		var workspace bool
		if qerr := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM agent_workspaces WHERE id = $1 AND tenant_id = $2 AND user_id = $3)`,
			workspaceID, tenantID, userID).Scan(&workspace); qerr != nil {
			return AgentWorkspace{}, fmt.Errorf("store: move agent workspace: %w", qerr)
		}
		if workspace {
			return AgentWorkspace{}, ErrAgentProjectNotFound
		}
		return AgentWorkspace{}, ErrNotFound
	}
	if err != nil {
		return AgentWorkspace{}, fmt.Errorf("store: move agent workspace: %w", err)
	}
	return w, nil
}
