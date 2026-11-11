-- Projects of the AI Agent (AgentProjectsService): kept per user by the
-- server and shared by the user's devices. A project has a name and,
-- optionally, the canonical key of the git repository it links
-- (spec/git-remote; never a URL as typed, so no credentials). Its
-- workspaces are folders on the user's machines. Only this metadata is
-- stored: no session, file or end-to-end content.
--
-- A workspace names its machine by the machine's X25519 public key, not by
-- machines.id: removing a machine and adding it again (tunelo keeps its key)
-- makes a new machines row, and the workspaces must come back to it. The
-- key only matches within the owner's own machines, so a key reported by
-- another account never reaches these rows.
--
-- A workspace belongs to its project's owner (composite foreign key), the
-- folder of one machine is one workspace of the owner at most, and a
-- repository is linked by one project of the owner at most. Deleting a
-- project deletes its workspace records only; nothing on a machine changes.
-- Erasing an account deletes its projects (trigger below).
--
-- outbox gets the kind agent_projects_changed: the hint that tells the
-- owner's other sessions to list the projects again.
--
-- Expand-only: new tables, function and trigger, and a wider CHECK; the
-- previous binary ignores the tables and never writes the new kind.

-- +goose Up

SET LOCAL lock_timeout = '5s';

CREATE TABLE agent_projects (
	id bigserial PRIMARY KEY,
	tenant_id text NOT NULL REFERENCES tenants (id),
	user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
	git_remote text CHECK (git_remote IS NULL OR octet_length(git_remote) BETWEEN 3 AND 512),
	sort_order integer NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT agent_projects_id_user_key UNIQUE (id, user_id)
);
CREATE INDEX agent_projects_user_idx ON agent_projects (tenant_id, user_id);
CREATE UNIQUE INDEX agent_projects_remote_key ON agent_projects (tenant_id, user_id, git_remote)
	WHERE git_remote IS NOT NULL;

CREATE TABLE agent_workspaces (
	id bigserial PRIMARY KEY,
	project_id bigint NOT NULL,
	tenant_id text NOT NULL REFERENCES tenants (id),
	user_id bigint NOT NULL,
	machine_key bytea NOT NULL CHECK (octet_length(machine_key) = 32),
	dir text NOT NULL CHECK (char_length(dir) BETWEEN 1 AND 1024),
	branch text NOT NULL DEFAULT '' CHECK (char_length(branch) <= 255),
	kind text NOT NULL CHECK (kind IN ('clone', 'worktree', 'folder')),
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT agent_workspaces_project_fkey FOREIGN KEY (project_id, user_id)
		REFERENCES agent_projects (id, user_id) ON DELETE CASCADE,
	CONSTRAINT agent_workspaces_dir_key UNIQUE (tenant_id, user_id, machine_key, dir)
);
CREATE INDEX agent_workspaces_project_idx ON agent_workspaces (project_id);

-- +goose StatementBegin
CREATE FUNCTION agent_projects_user_erased() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	DELETE FROM agent_projects WHERE user_id = NEW.id;
	RETURN NULL;
END
$$;
-- +goose StatementEnd

CREATE TRIGGER users_erased_agent_projects AFTER UPDATE OF deleted_at ON users
	FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
	EXECUTE FUNCTION agent_projects_user_erased();

ALTER TABLE outbox DROP CONSTRAINT outbox_kind_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_kind_check CHECK (kind IN ('message_new', 'message_edit', 'message_delete',
	'message_hidden', 'reaction', 'read', 'pin', 'member_added', 'member_removed', 'member_permissions',
	'chat_mode_changed', 'chat_updated', 'inline_button', 'session_revoked', 'topic_changed',
	'dialog_mute', 'pinned_dialogs', 'chat_deleted', 'dialog_unread_mark', 'notification_settings', 'inline_query',
	'user_changed', 'agent_projects_changed'));

-- +goose Down

SET LOCAL lock_timeout = '5s';

DELETE FROM outbox WHERE kind = 'agent_projects_changed';
ALTER TABLE outbox DROP CONSTRAINT outbox_kind_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_kind_check CHECK (kind IN ('message_new', 'message_edit', 'message_delete',
	'message_hidden', 'reaction', 'read', 'pin', 'member_added', 'member_removed', 'member_permissions',
	'chat_mode_changed', 'chat_updated', 'inline_button', 'session_revoked', 'topic_changed',
	'dialog_mute', 'pinned_dialogs', 'chat_deleted', 'dialog_unread_mark', 'notification_settings', 'inline_query',
	'user_changed'));
DROP TRIGGER users_erased_agent_projects ON users;
DROP FUNCTION agent_projects_user_erased();
DROP TABLE agent_workspaces;
DROP TABLE agent_projects;
