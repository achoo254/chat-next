-- The account is the root of trust between a user's devices and machines
-- (ADR 0013). account_devices holds the X25519 static public keys of the
-- user's devices (browsers, the phone app): the server hands the live ones
-- to the user's machines at every heartbeat, and a machine accepts a device
-- only while its key is listed.
--
-- Every key is bound to the chat session that registered it (session_id).
-- Revoking a key revokes that session, and a session that ends for any
-- reason (sign-out, revoked, replaced, IdP grant ended, account deletion)
-- revokes its keys through the trigger below; a session that only expired
-- is caught when the owner's keys are next read. A revoked key keeps its
-- row, so the same key can never be registered again (unique per user).
-- session_id becomes NULL when the session row is deleted at erasure; a
-- key without a session is never trusted.
--
-- machines: tunelo registers again with the same machine key after a
-- reinstall and keeps its row, so a live (user, key) pair is unique.
-- Duplicate live rows of one key are revoked first, keeping the one seen
-- last. idp_grant_id is the IdP grant of the tunelo-agent sign-in that
-- registered the machine; removing the machine revokes that grant
-- (grant_revoked_at once the IdP confirmed it).
--
-- Expand-only: new table, columns with constant defaults, a partial unique
-- index, a trigger on user_sessions and a wider erasure function. The
-- previous binary ignores them; machine_install_codes and
-- machine_revoked_devices stay for it until a later cleanup migration.

-- +goose Up

SET LOCAL lock_timeout = '5s';

CREATE TABLE account_devices (
	id bigserial PRIMARY KEY,
	tenant_id text NOT NULL REFERENCES tenants (id),
	user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	session_id bigint REFERENCES user_sessions (id) ON DELETE SET NULL,
	-- X25519 static public key of the device.
	public_key bytea NOT NULL CHECK (octet_length(public_key) = 32),
	name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
	platform text NOT NULL CHECK (char_length(platform) BETWEEN 1 AND 32),
	created_at timestamptz NOT NULL DEFAULT now(),
	last_seen_at timestamptz NOT NULL DEFAULT now(),
	revoked_at timestamptz,
	CONSTRAINT account_devices_user_key UNIQUE (user_id, public_key)
);
CREATE INDEX account_devices_user_live_idx ON account_devices (tenant_id, user_id) WHERE revoked_at IS NULL;
CREATE INDEX account_devices_session_idx ON account_devices (session_id) WHERE revoked_at IS NULL;

-- +goose StatementBegin
CREATE FUNCTION account_devices_session_ended() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	UPDATE account_devices SET revoked_at = now() WHERE session_id = NEW.id AND revoked_at IS NULL;
	RETURN NULL;
END
$$;
-- +goose StatementEnd

CREATE TRIGGER user_sessions_ended_devices AFTER UPDATE OF revoked_at ON user_sessions
	FOR EACH ROW WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
	EXECUTE FUNCTION account_devices_session_ended();

ALTER TABLE machines ADD COLUMN idp_grant_id text NOT NULL DEFAULT '' CHECK (char_length(idp_grant_id) <= 256);
ALTER TABLE machines ADD COLUMN grant_revoked_at timestamptz;

UPDATE machines SET revoked_at = now(), tunnel_url = ''
WHERE id IN (
	SELECT id FROM (
		SELECT id, row_number() OVER (PARTITION BY user_id, public_key ORDER BY last_seen_at DESC, id DESC) AS n
		FROM machines WHERE revoked_at IS NULL
	) ranked WHERE n > 1
);
CREATE UNIQUE INDEX machines_user_key_live_idx ON machines (user_id, public_key) WHERE revoked_at IS NULL;
CREATE INDEX machines_grant_pending_idx ON machines (tenant_id, revoked_at)
	WHERE revoked_at IS NOT NULL AND idp_grant_id <> '' AND grant_revoked_at IS NULL;

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION machines_user_erased() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	DELETE FROM machines WHERE user_id = NEW.id;
	DELETE FROM machine_install_codes WHERE user_id = NEW.id;
	DELETE FROM account_devices WHERE user_id = NEW.id;
	RETURN NULL;
END
$$;
-- +goose StatementEnd

-- +goose Down

SET LOCAL lock_timeout = '5s';

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION machines_user_erased() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	DELETE FROM machines WHERE user_id = NEW.id;
	DELETE FROM machine_install_codes WHERE user_id = NEW.id;
	RETURN NULL;
END
$$;
-- +goose StatementEnd

DROP INDEX machines_grant_pending_idx;
DROP INDEX machines_user_key_live_idx;
ALTER TABLE machines DROP COLUMN grant_revoked_at;
ALTER TABLE machines DROP COLUMN idp_grant_id;
DROP TRIGGER user_sessions_ended_devices ON user_sessions;
DROP FUNCTION account_devices_session_ended();
DROP TABLE account_devices;
