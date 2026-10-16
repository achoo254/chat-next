-- Personal data export, auto-delete when unused and deletion of the chat
-- account (Phase 12, Nghị định 13/2023; docs/privacy/data-inventory.md).
--
-- A deleted account keeps its users row as the author of the messages it
-- sent in other people's chats: deletion_requested_at starts the 30-day
-- grace period (the account is locked and shown as deleted), deleted_at
-- marks the erasure (profile emptied, username released, idp_sub cleared so
-- the next sign-in creates a new account). Exports are ZIP files on the
-- server's disk, listed in data_exports.
-- Expand-only: new nullable or defaulted columns, a relaxed CHECK, new table
-- and indexes; the previous binary never reads them, and it never meets a
-- user without idp_sub that is not a bot (none exists until this release
-- erases one).

-- +goose Up

SET LOCAL lock_timeout = '5s';

ALTER TABLE users
	ADD COLUMN deletion_requested_at timestamptz,
	ADD COLUMN deletion_reason text CHECK (deletion_reason IN ('user', 'inactive')),
	ADD COLUMN deleted_at timestamptz,
	-- Auto-delete after this many months without a session in use; 0 is off.
	ADD COLUMN auto_delete_months smallint NOT NULL DEFAULT 0 CHECK (auto_delete_months IN (0, 6, 12, 24)),
	ADD CONSTRAINT users_deletion_reason_set CHECK ((deletion_requested_at IS NULL) = (deletion_reason IS NULL));

ALTER TABLE users DROP CONSTRAINT users_idp_sub_unless_bot;
ALTER TABLE users ADD CONSTRAINT users_idp_sub_unless_bot CHECK (is_bot OR idp_sub IS NOT NULL OR deleted_at IS NOT NULL);

-- Accounts whose grace period runs (the purge job), and those that opted in
-- to auto-delete (the inactivity scan).
CREATE INDEX users_deletion_pending_idx ON users (deletion_requested_at)
	WHERE deletion_requested_at IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX users_auto_delete_idx ON users (tenant_id)
	WHERE auto_delete_months > 0 AND deleted_at IS NULL AND deletion_requested_at IS NULL;

CREATE TABLE data_exports (
	id bigserial PRIMARY KEY,
	tenant_id text NOT NULL REFERENCES tenants (id),
	user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'ready', 'failed', 'expired')),
	progress smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
	-- Name of the ZIP in the export directory (server generated, never from
	-- a user); empty until the build starts.
	file_name text NOT NULL DEFAULT '' CHECK (file_name ~ '^([0-9]+-[A-Za-z0-9_-]{22}\.zip)?$'),
	size_bytes bigint NOT NULL DEFAULT 0,
	-- Machine-readable reason of a failure (too_large, disk_full, internal).
	error text NOT NULL DEFAULT '',
	-- A builder holds the export while this lease runs; an expired lease
	-- after a crash lets another attempt start.
	lease_until timestamptz,
	attempts smallint NOT NULL DEFAULT 0,
	created_at timestamptz NOT NULL DEFAULT now(),
	ready_at timestamptz,
	expires_at timestamptz
);
CREATE INDEX data_exports_user_idx ON data_exports (user_id, id DESC);
CREATE INDEX data_exports_work_idx ON data_exports (id) WHERE status IN ('pending', 'running');
CREATE INDEX data_exports_expiry_idx ON data_exports (expires_at) WHERE status = 'ready';
-- One export in progress per user.
CREATE UNIQUE INDEX data_exports_one_open_idx ON data_exports (user_id) WHERE status IN ('pending', 'running');

-- +goose Down

SET LOCAL lock_timeout = '5s';

DROP TABLE data_exports;
DROP INDEX users_auto_delete_idx;
DROP INDEX users_deletion_pending_idx;
ALTER TABLE users DROP CONSTRAINT users_idp_sub_unless_bot;
-- Erased accounts get a placeholder sub, like bots in 0013's Down.
UPDATE users SET idp_sub = 'deleted:' || id WHERE idp_sub IS NULL AND NOT is_bot;
ALTER TABLE users ADD CONSTRAINT users_idp_sub_unless_bot CHECK (is_bot OR idp_sub IS NOT NULL);
ALTER TABLE users
	DROP CONSTRAINT users_deletion_reason_set,
	DROP COLUMN auto_delete_months,
	DROP COLUMN deleted_at,
	DROP COLUMN deletion_reason,
	DROP COLUMN deletion_requested_at;
