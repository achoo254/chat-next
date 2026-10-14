-- Incoming webhooks (release R2): hooks of a group or channel, idempotency
-- keys, alert groups updated in place, aggregated counters, dead letters
-- and the audit log. Expand-only: the previous binary never reads these
-- tables, and the trigger on chat_members only writes to them.

-- +goose Up

CREATE TABLE incoming_hooks (
	-- Public id in the URL: "hk_" and 12 base62 characters.
	id text PRIMARY KEY CHECK (id ~ '^hk_[A-Za-z0-9]{12}$'),
	tenant_id text NOT NULL REFERENCES tenants (id),
	chat_id bigint NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
	name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
	format text NOT NULL CHECK (format IN ('native', 'slack', 'alertmanager', 'grafana', 'gitlab')),
	allow_alert boolean NOT NULL DEFAULT false,
	silent boolean NOT NULL DEFAULT false,
	created_by bigint NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	-- SHA-256 of the secret; the secret itself is never stored.
	secret_hash bytea NOT NULL CHECK (length(secret_hash) = 32),
	secret_created_at timestamptz NOT NULL DEFAULT now(),
	secret_created_by bigint NOT NULL,
	-- Previous secret during its grace period (rotation).
	prev_secret_hash bytea CHECK (length(prev_secret_hash) = 32),
	prev_expires_at timestamptz,
	state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'disabled', 'auto_disabled')),
	disabled_reason text NOT NULL DEFAULT '' CHECK (disabled_reason IN ('', 'by_admin', 'creator_not_admin', 'creator_left')),
	disabled_at timestamptz,
	last_used_at timestamptz,
	updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incoming_hooks_chat_idx ON incoming_hooks (chat_id, created_at);
CREATE INDEX incoming_hooks_creator_idx ON incoming_hooks (chat_id, created_by);

-- Retries with the same idempotency_key return the first (chat_id, seq);
-- kept 24 hours.
CREATE TABLE hook_idempotency (
	hook_id text NOT NULL REFERENCES incoming_hooks (id) ON DELETE CASCADE,
	key text NOT NULL,
	chat_id bigint NOT NULL,
	seq bigint NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (hook_id, key)
);
CREATE INDEX hook_idempotency_created_idx ON hook_idempotency (created_at);

-- Alert groups (group_key, Alertmanager groupKey): the message updated in
-- place, its last status and the source time of that status, so an older
-- payload arriving late never overwrites a newer one. Kept 30 days after
-- the last update.
CREATE TABLE notify_groups (
	hook_id text NOT NULL REFERENCES incoming_hooks (id) ON DELETE CASCADE,
	group_key text NOT NULL,
	chat_id bigint NOT NULL,
	seq bigint NOT NULL,
	status text NOT NULL DEFAULT '',
	source_ts timestamptz NOT NULL,
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (hook_id, group_key)
);
CREATE INDEX notify_groups_updated_idx ON notify_groups (updated_at);

-- Counters per hook and hour, added up from memory every few seconds; kept
-- 30 days. No foreign key: counts flushed after a delete are dropped by
-- retention.
CREATE TABLE hook_counters (
	hook_id text NOT NULL,
	hour timestamptz NOT NULL,
	accepted bigint NOT NULL DEFAULT 0,
	delivered_realtime bigint NOT NULL DEFAULT 0,
	failed bigint NOT NULL DEFAULT 0,
	PRIMARY KEY (hook_id, hour)
);
CREATE INDEX hook_counters_hour_idx ON hook_counters (hour);

CREATE TABLE hook_failures (
	hook_id text NOT NULL,
	hour timestamptz NOT NULL,
	reason text NOT NULL,
	count bigint NOT NULL DEFAULT 0,
	last_at timestamptz NOT NULL,
	PRIMARY KEY (hook_id, hour, reason)
);
CREATE INDEX hook_failures_hour_idx ON hook_failures (hour);

-- Requests a hook could not process, with the body (at most 16 KiB); kept
-- 30 days.
CREATE TABLE hook_dead_letters (
	id bigserial PRIMARY KEY,
	hook_id text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	reason text NOT NULL,
	detail text NOT NULL DEFAULT '',
	http_status integer NOT NULL,
	content_type text NOT NULL DEFAULT '',
	body bytea NOT NULL,
	body_truncated boolean NOT NULL DEFAULT false
);
CREATE INDEX hook_dead_letters_hook_idx ON hook_dead_letters (hook_id, id);
CREATE INDEX hook_dead_letters_created_idx ON hook_dead_letters (created_at);

-- Audit log of hook management; append-only, survives the hook.
CREATE TABLE hook_audit (
	id bigserial PRIMARY KEY,
	tenant_id text NOT NULL,
	chat_id bigint NOT NULL,
	hook_id text NOT NULL,
	hook_name text NOT NULL,
	-- 0: the server.
	actor_id bigint NOT NULL,
	action text NOT NULL CHECK (action IN ('created', 'secret_rotated', 'previous_secret_revoked', 'disabled',
		'enabled', 'auto_disabled', 'taken_over', 'deleted')),
	detail text NOT NULL DEFAULT '',
	created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hook_audit_chat_idx ON hook_audit (chat_id, id);

-- +goose StatementBegin
CREATE FUNCTION hook_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'hook_audit is append-only';
END;
$$;
-- +goose StatementEnd
CREATE TRIGGER hook_audit_append_only BEFORE UPDATE OR DELETE ON hook_audit
	FOR EACH ROW EXECUTE FUNCTION hook_audit_append_only();

-- A hook stops when its creator stops being an admin of its chat (demoted,
-- left, removed, or the member row deleted with the chat). Done by a trigger
-- so every path that changes membership (chat service, moderation, chat
-- deletion) disables the hook in the same transaction, under the chat row
-- lock that every membership change takes first.
-- +goose StatementBegin
CREATE FUNCTION incoming_hooks_creator_lost() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	why text;
BEGIN
	IF OLD.role NOT IN ('admin', 'owner') OR OLD.left_at IS NOT NULL THEN
		RETURN NULL;
	END IF;
	IF TG_OP = 'DELETE' OR NEW.left_at IS NOT NULL THEN
		why := 'creator_left';
	ELSIF NEW.role NOT IN ('admin', 'owner') THEN
		why := 'creator_not_admin';
	ELSE
		RETURN NULL;
	END IF;
	WITH off AS (
		UPDATE incoming_hooks SET state = 'auto_disabled', disabled_reason = why, disabled_at = now(), updated_at = now()
		WHERE chat_id = OLD.chat_id AND created_by = OLD.user_id AND state = 'active'
		RETURNING tenant_id, chat_id, id, name
	)
	INSERT INTO hook_audit (tenant_id, chat_id, hook_id, hook_name, actor_id, action, detail)
	SELECT tenant_id, chat_id, id, name, 0, 'auto_disabled', why FROM off;
	RETURN NULL;
END;
$$;
-- +goose StatementEnd
CREATE TRIGGER incoming_hooks_creator_lost AFTER UPDATE OF role, left_at OR DELETE ON chat_members
	FOR EACH ROW EXECUTE FUNCTION incoming_hooks_creator_lost();

-- +goose Down

DROP TRIGGER incoming_hooks_creator_lost ON chat_members;
DROP FUNCTION incoming_hooks_creator_lost();
DROP TABLE hook_audit;
DROP FUNCTION hook_audit_append_only();
DROP TABLE hook_dead_letters;
DROP TABLE hook_failures;
DROP TABLE hook_counters;
DROP TABLE notify_groups;
DROP TABLE hook_idempotency;
DROP TABLE incoming_hooks;
