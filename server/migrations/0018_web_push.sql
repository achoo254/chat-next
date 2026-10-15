-- Web Push (PWA): one browser push subscription per chat session
-- (PushService), and the outbox consumer "push" that sends them.
-- A subscription lives as long as its session: revoking the session deletes
-- it in the same transaction (trigger below), and the sender also skips
-- sessions past their idle or maximum age. Expand-only: new table,
-- function, trigger and cursor row; the previous binary ignores them.

-- +goose Up

SET LOCAL lock_timeout = '5s';

CREATE TABLE push_subscriptions (
	id bigserial PRIMARY KEY,
	tenant_id text NOT NULL REFERENCES tenants (id),
	user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	session_id bigint NOT NULL REFERENCES user_sessions (id) ON DELETE CASCADE,
	-- https URL on a browser vendor's push service (allowlisted on register).
	endpoint text NOT NULL CHECK (length(endpoint) BETWEEN 1 AND 2048),
	-- RFC 8291 keys of the browser: P-256 public key (uncompressed) and
	-- the authentication secret.
	p256dh bytea NOT NULL CHECK (octet_length(p256dh) = 65),
	auth bytea NOT NULL CHECK (octet_length(auth) = 16),
	-- Language of the notification text.
	locale text NOT NULL DEFAULT 'vi' CHECK (locale IN ('vi', 'en')),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	last_sent_at timestamptz,
	-- Consecutive rejected sends (4xx other than 404, 410, 429); the
	-- subscription is dropped when it reaches the sender's limit.
	failures smallint NOT NULL DEFAULT 0,
	CONSTRAINT push_subscriptions_session_key UNIQUE (session_id),
	CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint)
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);

-- +goose StatementBegin
CREATE FUNCTION push_session_revoked() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	DELETE FROM push_subscriptions WHERE session_id = NEW.id;
	RETURN NULL;
END
$$;
-- +goose StatementEnd

CREATE TRIGGER user_sessions_revoked_push AFTER UPDATE OF revoked_at ON user_sessions
	FOR EACH ROW WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
	EXECUTE FUNCTION push_session_revoked();

-- The push consumer starts at the head of the log: no pushes for history.
INSERT INTO outbox_cursors (consumer, last_id) SELECT 'push', coalesce(max(id), 0) FROM outbox
ON CONFLICT (consumer) DO NOTHING;

-- +goose Down

SET LOCAL lock_timeout = '5s';

DELETE FROM outbox_cursors WHERE consumer = 'push';
DROP TRIGGER user_sessions_revoked_push ON user_sessions;
DROP FUNCTION push_session_revoked();
DROP TABLE push_subscriptions;
