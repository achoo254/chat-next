-- Bot API core (release R5): a bot is a user with is_bot, owned by a chat
-- user of the same tenant, without an IdP account. Bots talk to the server
-- through the HTTP Bot API (https://chat.<domain>/bot/v1/...) with a token
-- whose secret is stored only as SHA-256. Updates for bots are cut from the
-- outbox by the "bots" consumer into bot_updates, each bot with its own
-- strictly increasing update_id (bots.next_update_id, one writer per bot
-- under the bots row lock).
-- Expand-only: the previous binary never reads idp_sub of a bot (bots have
-- no sessions) and ignores the new columns and tables.

-- +goose Up

-- The ALTERs of users and user_sessions take ACCESS EXCLUSIVE locks (the
-- CHECK scans users once). Waiting behind a long transaction would queue
-- every request behind the migration, so give up after 5 s instead; the
-- deploy fails and is retried. SET LOCAL ends with goose's transaction.
SET LOCAL lock_timeout = '5s';

ALTER TABLE users ADD COLUMN is_bot boolean NOT NULL DEFAULT false;
ALTER TABLE users ALTER COLUMN idp_sub DROP NOT NULL;
-- users_tenant_idp_sub_key stays: NULLs never collide, so every bot fits.
ALTER TABLE users ADD CONSTRAINT users_idp_sub_unless_bot CHECK (is_bot OR idp_sub IS NOT NULL);

-- IdP auth_time of the sign-in that created the session (ADR 0006: token
-- reveal and bot deletion need a sign-in within the last 10 minutes); NULL
-- when the ID token carried none.
ALTER TABLE user_sessions ADD COLUMN auth_time timestamptz;

CREATE TABLE bots (
	user_id bigint PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
	tenant_id text NOT NULL REFERENCES tenants (id),
	owner_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	-- SHA-256 of the token secret; NULL before the first token is issued and
	-- after the bot is deleted.
	token_hash bytea CHECK (octet_length(token_hash) = 32),
	token_issued_at timestamptz,
	-- Shown before the user starts the bot ("what can this bot do?").
	description text NOT NULL DEFAULT '',
	-- Short profile text.
	about text NOT NULL DEFAULT '',
	-- Privacy mode: in groups only commands, replies to the bot and service
	-- messages reach it.
	privacy boolean NOT NULL DEFAULT true,
	-- Rate limit tiers; only the hoandat operations team sets them.
	verified boolean NOT NULL DEFAULT false,
	internal boolean NOT NULL DEFAULT false,
	-- [{"scope": "default|private|group|group_admin", "commands": [{"command", "description"}]}]
	commands jsonb NOT NULL DEFAULT '[]',
	next_update_id bigint NOT NULL DEFAULT 1,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	deleted_at timestamptz
);
CREATE INDEX bots_owner_idx ON bots (owner_id) WHERE deleted_at IS NULL;

-- Users a bot may write to in private (consent invariant): written when the
-- user starts the bot, follows its deep link, presses its button or writes
-- to it. Groups and channels need membership instead.
CREATE TABLE bot_user_consent (
	bot_id bigint NOT NULL REFERENCES bots (user_id) ON DELETE CASCADE,
	user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	source text NOT NULL CHECK (source IN ('start', 'deep_link', 'button', 'message')),
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (bot_id, user_id)
);

-- Inline button presses. outbox_id is the inline_button outbox row written
-- in the same transaction; the bots consumer turns it into a callback
-- update. The bot answers once.
CREATE TABLE bot_callbacks (
	id text PRIMARY KEY,
	bot_id bigint NOT NULL REFERENCES bots (user_id) ON DELETE CASCADE,
	user_id bigint NOT NULL,
	chat_id bigint NOT NULL,
	seq bigint NOT NULL,
	data bytea NOT NULL,
	outbox_id bigint,
	created_at timestamptz NOT NULL DEFAULT now(),
	answered_at timestamptz,
	answer_text text NOT NULL DEFAULT '',
	answer_alert boolean NOT NULL DEFAULT false,
	answer_url text NOT NULL DEFAULT ''
);
CREATE INDEX bot_callbacks_outbox_idx ON bot_callbacks (outbox_id);
CREATE INDEX bot_callbacks_created_idx ON bot_callbacks (created_at);

-- Updates per bot, serialized for the bot when cut from the outbox.
-- (bot_id, outbox_id, kind, seq) makes a replayed outbox row a no-op: seq
-- is the message the update is about, so the key does not depend on which
-- other messages of the row still exist at replay time. An acknowledged
-- update stays (acked) until expires_at, so a replay after the bot
-- acknowledged it still finds it and does not deliver it again.
CREATE TABLE bot_updates (
	bot_id bigint NOT NULL REFERENCES bots (user_id) ON DELETE CASCADE,
	update_id bigint NOT NULL,
	outbox_id bigint NOT NULL,
	kind text NOT NULL CHECK (kind IN ('message', 'message_edited', 'callback')),
	seq bigint NOT NULL,
	chat_id bigint NOT NULL DEFAULT 0,
	payload jsonb NOT NULL,
	acked boolean NOT NULL DEFAULT false,
	created_at timestamptz NOT NULL DEFAULT now(),
	expires_at timestamptz NOT NULL,
	PRIMARY KEY (bot_id, update_id),
	CONSTRAINT bot_updates_outbox_key UNIQUE (bot_id, outbox_id, kind, seq)
);
CREATE INDEX bot_updates_expires_idx ON bot_updates (expires_at);

-- The consumer starts at the head of the log: nothing before this release
-- concerns a bot.
INSERT INTO outbox_cursors (consumer, last_id) SELECT 'bots', coalesce(max(id), 0) FROM outbox
ON CONFLICT (consumer) DO NOTHING;

-- +goose Down

DELETE FROM outbox_cursors WHERE consumer = 'bots';
DROP TABLE bot_updates;
DROP TABLE bot_callbacks;
DROP TABLE bot_user_consent;
DROP TABLE bots;
ALTER TABLE user_sessions DROP COLUMN auth_time;
ALTER TABLE users DROP CONSTRAINT users_idp_sub_unless_bot;
-- Bot accounts stay as authors of their messages, with a placeholder sub.
UPDATE users SET idp_sub = 'bot:' || id WHERE idp_sub IS NULL;
ALTER TABLE users ALTER COLUMN idp_sub SET NOT NULL;
ALTER TABLE users DROP COLUMN is_bot;
