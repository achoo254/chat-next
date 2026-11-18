-- Chat Bridge: what is synced for a chat is set per feature (messages, pins, topics,
-- reactions, ...), not only per chat. A chat with no row for a feature takes the
-- default for it (internal/bridge/feature); `messages` keeps following
-- external_chats.direction. The outbox learns which feature a row belongs to and can
-- carry a payload for features whose change is more than a message number, so a new
-- feature or app adds rows and code, not columns.

-- +goose Up

SET LOCAL lock_timeout = '5s';

CREATE TABLE external_chat_features (
	account_id bigint NOT NULL,
	external_chat_id text NOT NULL,
	feature text NOT NULL CHECK (feature <> ''),
	direction text NOT NULL CHECK (direction IN ('off', 'in', 'out', 'both')),
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (account_id, external_chat_id, feature),
	FOREIGN KEY (account_id, external_chat_id) REFERENCES external_chats (account_id, external_chat_id) ON DELETE CASCADE
);

-- The set of ops is checked in code from now on: a new feature adds ops without a migration.
ALTER TABLE external_outbox DROP CONSTRAINT external_outbox_op_check;
ALTER TABLE external_outbox ADD COLUMN feature text NOT NULL DEFAULT '';
ALTER TABLE external_outbox ADD COLUMN payload jsonb NOT NULL DEFAULT '{}';
UPDATE external_outbox SET feature = CASE op
	WHEN 'pin_message' THEN 'pins'
	WHEN 'pin_topic' THEN 'topics'
	ELSE 'messages' END
WHERE feature = '';

-- +goose Down

DROP TABLE external_chat_features;
DELETE FROM external_outbox WHERE op NOT IN ('send', 'edit', 'delete', 'pin_message', 'pin_topic');
ALTER TABLE external_outbox DROP COLUMN payload;
ALTER TABLE external_outbox DROP COLUMN feature;
ALTER TABLE external_outbox ADD CONSTRAINT external_outbox_op_check CHECK (op IN ('send', 'edit', 'delete', 'pin_message', 'pin_topic'));
