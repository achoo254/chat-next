-- Folders the user dropped from the AI Agent while their machine could not
-- be told (the machine was offline to the device that deleted the project or
-- workspace). The web syncs the folders a machine keeps as projects into
-- workspaces; without this mark a second device would record the folder
-- again and the deleted project would come back. Until now the mark lived in
-- the deleting device's own browser, out of the other devices' reach.
--
-- A row names the folder by the machine's public key (as agent_workspaces
-- does, so it survives removing and adding a machine) and its path. It is
-- deleted when the machine has dropped the folder, or when the folder is
-- recorded as a workspace again. Metadata only, like the projects. Erasing
-- an account deletes its rows (the existing trigger function, widened).
--
-- Expand-only: a new table and a function body that also deletes from it;
-- the previous binary ignores the table.

-- +goose Up

SET LOCAL lock_timeout = '5s';

CREATE TABLE agent_detached_folders (
	tenant_id text NOT NULL REFERENCES tenants (id),
	user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	machine_key bytea NOT NULL CHECK (octet_length(machine_key) = 32),
	dir text NOT NULL CHECK (char_length(dir) BETWEEN 1 AND 1024),
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (tenant_id, user_id, machine_key, dir)
);

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION agent_projects_user_erased() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	DELETE FROM agent_projects WHERE user_id = NEW.id;
	DELETE FROM agent_detached_folders WHERE user_id = NEW.id;
	RETURN NULL;
END
$$;
-- +goose StatementEnd

-- +goose Down

SET LOCAL lock_timeout = '5s';

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION agent_projects_user_erased() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	DELETE FROM agent_projects WHERE user_id = NEW.id;
	RETURN NULL;
END
$$;
-- +goose StatementEnd

DROP TABLE agent_detached_folders;
