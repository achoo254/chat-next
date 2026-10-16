-- Inline mode of bots: a user types @bot query in a chat; the bot gets an
-- inline_query update and answers with results; the user's pick is posted
-- by the user "via" the bot. Expand-only: a nullable-free defaulted column,
-- a new table and wider CHECKs; the previous binary ignores them.

-- +goose Up

SET LOCAL lock_timeout = '5s';

-- The composer hint of a bot with inline mode on; '' is off.
ALTER TABLE bots ADD COLUMN inline_placeholder text NOT NULL DEFAULT '';

-- One query and the bot's answer. results is an app.v1 InlineAnswer
-- (results with their message content); file_ids are the files it shows,
-- which the asking user may download while the query lives (1 hour).
CREATE TABLE bot_inline_queries (
	id text PRIMARY KEY,
	-- The media host's download tokens name a query by this number.
	num bigserial UNIQUE,
	tenant_id text NOT NULL REFERENCES tenants (id),
	bot_id bigint NOT NULL REFERENCES bots (user_id) ON DELETE CASCADE,
	user_id bigint NOT NULL,
	chat_id bigint NOT NULL,
	chat_type text NOT NULL,
	query text NOT NULL,
	"offset" text NOT NULL DEFAULT '',
	outbox_id bigint,
	created_at timestamptz NOT NULL DEFAULT now(),
	answered_at timestamptz,
	results bytea,
	file_ids bigint[] NOT NULL DEFAULT '{}',
	-- The answer may be reused for the same bot, query and offset (and the
	-- same user when personal) until cache_until.
	personal boolean NOT NULL DEFAULT false,
	cache_until timestamptz
);
CREATE INDEX bot_inline_queries_outbox_idx ON bot_inline_queries (outbox_id);
CREATE INDEX bot_inline_queries_cache_idx ON bot_inline_queries (bot_id, query, "offset", cache_until) WHERE answered_at IS NOT NULL;

ALTER TABLE outbox DROP CONSTRAINT outbox_kind_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_kind_check CHECK (kind IN ('message_new', 'message_edit', 'message_delete',
	'message_hidden', 'reaction', 'read', 'pin', 'member_added', 'member_removed', 'member_permissions',
	'chat_mode_changed', 'chat_updated', 'inline_button', 'session_revoked', 'topic_changed',
	'dialog_mute', 'pinned_dialogs', 'chat_deleted', 'dialog_unread_mark', 'notification_settings', 'inline_query'));

ALTER TABLE bot_updates DROP CONSTRAINT bot_updates_kind_check;
ALTER TABLE bot_updates ADD CONSTRAINT bot_updates_kind_check
	CHECK (kind IN ('message', 'message_edited', 'callback', 'channel_post', 'member_changed', 'reaction', 'inline_query'));

-- +goose Down

DELETE FROM bot_updates WHERE kind = 'inline_query';
ALTER TABLE bot_updates DROP CONSTRAINT bot_updates_kind_check;
ALTER TABLE bot_updates ADD CONSTRAINT bot_updates_kind_check
	CHECK (kind IN ('message', 'message_edited', 'callback', 'channel_post', 'member_changed', 'reaction'));
DELETE FROM outbox WHERE kind = 'inline_query';
ALTER TABLE outbox DROP CONSTRAINT outbox_kind_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_kind_check CHECK (kind IN ('message_new', 'message_edit', 'message_delete',
	'message_hidden', 'reaction', 'read', 'pin', 'member_added', 'member_removed', 'member_permissions',
	'chat_mode_changed', 'chat_updated', 'inline_button', 'session_revoked', 'topic_changed',
	'dialog_mute', 'pinned_dialogs', 'chat_deleted', 'dialog_unread_mark', 'notification_settings'));
DROP TABLE bot_inline_queries;
ALTER TABLE bots DROP COLUMN inline_placeholder;
