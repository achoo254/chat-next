-- My machines (ADR 0013): the directory of the computers where a user runs
-- tunelo (MachinesService, MachineAgentService). The server lists them,
-- hands out install codes and pushes "needs you" notices; it never holds a
-- pairing secret and is never a root of trust for a machine's key.
--
-- Install codes and machine secrets are stored as SHA-256 hashes only, as
-- session tokens are. A revoked machine keeps its row (revoked_at) so its
-- next heartbeat can be told to stop; machine_revoked_devices lists the
-- paired devices the user revoked, sent to the machine at each heartbeat.
-- Erasing an account deletes its machines and install codes (trigger below).
--
-- Expand-only: new tables, function and trigger; the previous binary
-- ignores them.

-- +goose Up

SET LOCAL lock_timeout = '5s';

CREATE TABLE machines (
	id bigserial PRIMARY KEY,
	tenant_id text NOT NULL REFERENCES tenants (id),
	user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
	-- Node's process.platform and process.arch.
	os text NOT NULL CHECK (os IN ('darwin', 'win32', 'linux')),
	arch text NOT NULL CHECK (arch IN ('arm64', 'x64')),
	agent_version text NOT NULL CHECK (char_length(agent_version) BETWEEN 1 AND 32),
	claude_version text NOT NULL DEFAULT '' CHECK (char_length(claude_version) <= 64),
	-- X25519 static public key of the machine, informational only.
	public_key bytea NOT NULL CHECK (octet_length(public_key) = 32),
	-- wss://<subdomain>.tunnel.<domain>; empty while the tunnel is down.
	tunnel_url text NOT NULL DEFAULT '' CHECK (char_length(tunnel_url) <= 256),
	secret_hash bytea NOT NULL CHECK (octet_length(secret_hash) = 32),
	created_at timestamptz NOT NULL DEFAULT now(),
	last_seen_at timestamptz NOT NULL DEFAULT now(),
	revoked_at timestamptz,
	CONSTRAINT machines_secret_hash_key UNIQUE (secret_hash)
);
CREATE INDEX machines_user_idx ON machines (tenant_id, user_id) WHERE revoked_at IS NULL;

CREATE TABLE machine_install_codes (
	code_hash bytea PRIMARY KEY CHECK (octet_length(code_hash) = 32),
	tenant_id text NOT NULL REFERENCES tenants (id),
	user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	created_at timestamptz NOT NULL DEFAULT now(),
	expires_at timestamptz NOT NULL,
	used_at timestamptz
);
CREATE INDEX machine_install_codes_user_idx ON machine_install_codes (tenant_id, user_id);

CREATE TABLE machine_revoked_devices (
	machine_id bigint NOT NULL REFERENCES machines (id) ON DELETE CASCADE,
	tenant_id text NOT NULL REFERENCES tenants (id),
	-- X25519 static public key of the revoked device.
	device_public_key bytea NOT NULL CHECK (octet_length(device_public_key) = 32),
	revoked_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (machine_id, device_public_key)
);

-- +goose StatementBegin
CREATE FUNCTION machines_user_erased() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	DELETE FROM machines WHERE user_id = NEW.id;
	DELETE FROM machine_install_codes WHERE user_id = NEW.id;
	RETURN NULL;
END
$$;
-- +goose StatementEnd

CREATE TRIGGER users_erased_machines AFTER UPDATE OF deleted_at ON users
	FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
	EXECUTE FUNCTION machines_user_erased();

-- +goose Down

SET LOCAL lock_timeout = '5s';

DROP TRIGGER users_erased_machines ON users;
DROP FUNCTION machines_user_erased();
DROP TABLE machine_revoked_devices;
DROP TABLE machine_install_codes;
DROP TABLE machines;
