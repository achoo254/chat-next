-- Chat Bridge (ADR 0022): conversations of another app (Telegram first) are
-- imported into Chat. An external account is a signed-in account in the
-- other app, owned by one Chat user; its contacts become puppet users
-- (users.external_source), its chats link to ordinary chats, its messages
-- map to (chat_id, seq) so an import can be repeated without duplicates.
--
-- The system is single-tenant, so none of these tables has a tenant_id.
-- External ids are opaque text the core never parses.
--
-- Expand-only: new tables, one new column and a wider CHECK on users; the
-- previous binary ignores all of it.

-- +goose Up

SET LOCAL lock_timeout = '5s';

-- A puppet user stands for a contact of the other app. It has no IdP
-- account (idp_sub NULL), cannot sign in and is never offered to other
-- users; external_source names the app ("telegram").
ALTER TABLE users ADD COLUMN external_source text;
ALTER TABLE users ADD CONSTRAINT users_external_source_check CHECK (external_source IS NULL OR external_source ~ '^[a-z][a-z0-9_]{0,31}$');
ALTER TABLE users DROP CONSTRAINT users_idp_sub_unless_bot;
ALTER TABLE users ADD CONSTRAINT users_idp_sub_unless_bot_or_external CHECK (is_bot OR external_source IS NOT NULL OR idp_sub IS NOT NULL);

CREATE TABLE external_accounts (
	id bigserial PRIMARY KEY,
	owner_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	source text NOT NULL CHECK (source ~ '^[a-z][a-z0-9_]{0,31}$'),
	-- The account id in the other app; the same account cannot be linked twice.
	external_ref text NOT NULL,
	status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_login', 'stopped')),
	-- The adapter's login state, sealed by sealbox (AAD: id, owner, source).
	secret bytea NOT NULL,
	-- The adapter's own update state (for example Telegram pts and date),
	-- opaque to the core; written in the transaction of the message it follows.
	update_state bytea,
	-- One connection per account: the holder and when its claim lapses.
	lease_holder text,
	lease_until timestamptz,
	last_error text NOT NULL DEFAULT '' CHECK (octet_length(last_error) <= 512),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (source, external_ref)
);
CREATE INDEX external_accounts_owner_idx ON external_accounts (owner_id);

CREATE TABLE external_chats (
	id bigserial PRIMARY KEY,
	account_id bigint NOT NULL REFERENCES external_accounts (id) ON DELETE CASCADE,
	external_chat_id text NOT NULL,
	chat_id bigint NOT NULL REFERENCES chats (id),
	-- 'in': the other app is the source and Chat refuses to send into the
	-- chat. 'both' is for a later step (a send queue).
	direction text NOT NULL DEFAULT 'in' CHECK (direction IN ('in', 'both')),
	-- How many of the newest messages the first import takes; chosen once.
	history_window integer NOT NULL DEFAULT 2000 CHECK (history_window BETWEEN 0 AND 100000),
	-- True once the import has caught up with the newest message; live
	-- messages wait until then so seq stays in time order.
	backfill_done boolean NOT NULL DEFAULT false,
	-- Where the import resumes (an external message id, opaque).
	backfill_cursor text NOT NULL DEFAULT '',
	created_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (account_id, external_chat_id),
	UNIQUE (chat_id)
);

CREATE TABLE external_users (
	id bigserial PRIMARY KEY,
	account_id bigint NOT NULL REFERENCES external_accounts (id) ON DELETE CASCADE,
	external_user_id text NOT NULL,
	user_id bigint NOT NULL REFERENCES users (id),
	UNIQUE (account_id, external_user_id),
	UNIQUE (user_id)
);

-- The idempotency key of an imported message. source_edit_version orders
-- edits so an older copy never overwrites a newer one; external_reply_to
-- holds a reply whose original has not arrived yet.
CREATE TABLE external_messages (
	account_id bigint NOT NULL REFERENCES external_accounts (id) ON DELETE CASCADE,
	external_chat_id text NOT NULL,
	external_msg_id text NOT NULL,
	chat_id bigint NOT NULL,
	seq bigint NOT NULL,
	source_edit_version bigint NOT NULL DEFAULT 0,
	external_reply_to text NOT NULL DEFAULT '',
	PRIMARY KEY (account_id, external_chat_id, external_msg_id)
);
-- A delete that names no chat finds the message by id alone.
CREATE INDEX external_messages_msg_idx ON external_messages (account_id, external_msg_id);
CREATE INDEX external_messages_chat_seq_idx ON external_messages (chat_id, seq);
CREATE INDEX external_messages_pending_reply_idx ON external_messages (account_id, external_chat_id, external_reply_to)
	WHERE external_reply_to <> '';

-- A delete that arrived before its message: the message is dropped when it
-- shows up. external_chat_id is empty when the delete named no chat.
CREATE TABLE external_tombstones (
	account_id bigint NOT NULL REFERENCES external_accounts (id) ON DELETE CASCADE,
	external_chat_id text NOT NULL,
	external_msg_id text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (account_id, external_chat_id, external_msg_id)
);

-- Sessions of erased accounts that still have to be logged out in the other
-- app. The account row is deleted with its owner's data; this keeps just
-- what logging out needs until the bridge has done it.
CREATE TABLE external_logouts (
	id bigserial PRIMARY KEY,
	source text NOT NULL,
	account_id bigint NOT NULL,
	owner_id bigint NOT NULL,
	secret bytea NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	attempts integer NOT NULL DEFAULT 0
);

-- +goose StatementBegin
CREATE FUNCTION external_accounts_user_erased() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	-- The contacts of the other app are third parties: their puppet users
	-- lose name, username and photo along with the owner's data.
	UPDATE users u SET username = 'deleted_' || u.id, name = '', bio = '', photo_file_id = NULL,
			deleted_at = now(), updated_at = now()
		FROM external_users eu JOIN external_accounts ea ON ea.id = eu.account_id
		WHERE ea.owner_id = NEW.id AND u.id = eu.user_id AND u.deleted_at IS NULL;
	INSERT INTO external_logouts (source, account_id, owner_id, secret)
		SELECT source, id, owner_id, secret FROM external_accounts WHERE owner_id = NEW.id;
	DELETE FROM external_accounts WHERE owner_id = NEW.id;
	RETURN NULL;
END
$$;
-- +goose StatementEnd

CREATE TRIGGER users_erased_external_accounts AFTER UPDATE OF deleted_at ON users
	FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
	EXECUTE FUNCTION external_accounts_user_erased();

-- +goose Down

SET LOCAL lock_timeout = '5s';

DROP TRIGGER users_erased_external_accounts ON users;
DROP FUNCTION external_accounts_user_erased();
DROP TABLE external_logouts;
DROP TABLE external_tombstones;
DROP TABLE external_messages;
DROP TABLE external_users;
DROP TABLE external_chats;
DROP TABLE external_accounts;
ALTER TABLE users DROP CONSTRAINT users_idp_sub_unless_bot_or_external;
ALTER TABLE users ADD CONSTRAINT users_idp_sub_unless_bot CHECK (is_bot OR idp_sub IS NOT NULL);
ALTER TABLE users DROP CONSTRAINT users_external_source_check;
ALTER TABLE users DROP COLUMN external_source;
