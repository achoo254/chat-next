-- Chats, members, messages and the sync logs (ADR 0001, 0002, 0003),
-- forum topics, invite links, privacy, blocks, reports and the link preview
-- cache. Every chat and invite link is scoped by tenant (ADR 0010).
--
-- Time-partitioned tables (user_updates, chat_updates, outbox) get one
-- partition per UTC day from chat_ensure_day_partitions(), which the api role
-- calls at start and every hour; partitions older than the retention are
-- dropped whole, never row by row.

-- +goose Up

-- server_epoch increases after every database failover or restore so clients
-- resync (ADR 0002). Operators bump it as the last step of a restore.
CREATE TABLE server_meta (
	id boolean PRIMARY KEY DEFAULT true CHECK (id),
	server_epoch bigint NOT NULL DEFAULT 1 CHECK (server_epoch > 0 AND server_epoch < 9007199254740992)
);
INSERT INTO server_meta DEFAULT VALUES;

-- Snowflake worker numbers leased by running processes (ids package). A new
-- holder starts issuing only after last_ms, the newest millisecond the
-- previous holder may have used.
CREATE TABLE snowflake_workers (
	worker integer PRIMARY KEY CHECK (worker BETWEEN 0 AND 1023),
	holder text,
	lease_until timestamptz NOT NULL DEFAULT '-infinity',
	last_ms bigint NOT NULL DEFAULT 0
);
INSERT INTO snowflake_workers (worker) SELECT generate_series(0, 1023);

ALTER TABLE users ADD COLUMN last_seen_at timestamptz;

-- Audience values follow app.v1.PrivacyAudience: 1 everyone, 2 contacts,
-- 3 nobody. A user without a row has the defaults below.
CREATE TABLE privacy_settings (
	user_id bigint PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
	last_seen smallint NOT NULL DEFAULT 2 CHECK (last_seen BETWEEN 1 AND 3),
	profile_photo smallint NOT NULL DEFAULT 1 CHECK (profile_photo BETWEEN 1 AND 3),
	find_by_email smallint NOT NULL DEFAULT 3 CHECK (find_by_email BETWEEN 1 AND 3),
	find_by_username smallint NOT NULL DEFAULT 1 CHECK (find_by_username BETWEEN 1 AND 3),
	add_to_groups smallint NOT NULL DEFAULT 2 CHECK (add_to_groups BETWEEN 1 AND 3),
	send_messages smallint NOT NULL DEFAULT 1 CHECK (send_messages BETWEEN 1 AND 3),
	notification_preview boolean NOT NULL DEFAULT true,
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE blocks (
	blocker_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	blocked_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (blocker_id, blocked_id),
	CHECK (blocker_id <> blocked_id)
);
CREATE INDEX blocks_blocked_idx ON blocks (blocked_id);

-- Per-shard local part of chat ids (ids.MakeSharded): 1 .. 2^43-1.
CREATE SEQUENCE chat_local_id_seq AS bigint MINVALUE 1 MAXVALUE 8796093022207;

CREATE TABLE chats (
	id bigint PRIMARY KEY CHECK (id > 0 AND id < 9007199254740992),
	tenant_id text NOT NULL REFERENCES tenants (id),
	type text NOT NULL CHECK (type IN ('private', 'group', 'channel', 'secret')),
	title text NOT NULL DEFAULT '',
	about text NOT NULL DEFAULT '',
	creator_id bigint NOT NULL REFERENCES users (id),
	sync_mode text NOT NULL DEFAULT 'small' CHECK (sync_mode IN ('small', 'large')),
	history_visibility text NOT NULL DEFAULT 'shared' CHECK (history_visibility IN ('shared', 'since_join')),
	-- app.v1.ChatPermission bits of ordinary members.
	default_permissions integer NOT NULL DEFAULT 0,
	forum boolean NOT NULL DEFAULT false CHECK (NOT forum OR type = 'group'),
	-- Newest seq; seqs are issued under this row's lock (ADR 0001).
	last_seq bigint NOT NULL DEFAULT 0,
	-- Per-chat log position of a sync_mode=large chat (ADR 0002).
	chat_pts bigint NOT NULL DEFAULT 0,
	chat_pts_at timestamptz NOT NULL DEFAULT now(),
	last_topic_id bigint NOT NULL DEFAULT 0,
	member_count integer NOT NULL DEFAULT 0,
	pinned_seq bigint NOT NULL DEFAULT 0,
	last_message_at timestamptz NOT NULL DEFAULT now(),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chats_tenant_idx ON chats (tenant_id);

-- At most one private chat per pair of users (lower id first).
CREATE TABLE private_chats (
	tenant_id text NOT NULL REFERENCES tenants (id),
	user_low bigint NOT NULL REFERENCES users (id),
	user_high bigint NOT NULL REFERENCES users (id),
	chat_id bigint NOT NULL UNIQUE REFERENCES chats (id) ON DELETE CASCADE,
	PRIMARY KEY (tenant_id, user_low, user_high),
	CHECK (user_low < user_high)
);

CREATE TABLE chat_members (
	chat_id bigint NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
	user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	role text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin', 'owner')),
	-- Custom ChatPermission bits; NULL follows chats.default_permissions.
	permissions integer,
	inviter_id bigint NOT NULL DEFAULT 0,
	joined_at timestamptz NOT NULL DEFAULT now(),
	-- chats.last_seq when the member (re)joined: older messages never count
	-- as unread.
	joined_seq bigint NOT NULL DEFAULT 0,
	-- History visibility: the member sees seq >= visible_from_seq.
	visible_from_seq bigint NOT NULL DEFAULT 0,
	-- Highest seq of this member's messages read by others (small chats).
	read_outbox_max_seq bigint NOT NULL DEFAULT 0,
	left_at timestamptz,
	PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX chat_members_user_idx ON chat_members (user_id, chat_id) WHERE left_at IS NULL;

-- Forum topics (Validation Session 11): metadata of a group. Topic 1 is
-- "General", created when the forum is turned on.
CREATE TABLE forum_topics (
	chat_id bigint NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
	id bigint NOT NULL CHECK (id > 0),
	title text NOT NULL,
	icon_color integer NOT NULL DEFAULT 0 CHECK (icon_color BETWEEN 0 AND 16777215),
	creator_id bigint NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	pinned boolean NOT NULL DEFAULT false,
	closed boolean NOT NULL DEFAULT false,
	hidden boolean NOT NULL DEFAULT false,
	top_seq bigint NOT NULL DEFAULT 0,
	PRIMARY KEY (chat_id, id)
);

-- Read position per (chat, user, topic). topic_id 0 is the chat as a whole;
-- in a forum it holds the highest seq read in any topic.
CREATE TABLE chat_read_states (
	chat_id bigint NOT NULL,
	user_id bigint NOT NULL,
	topic_id bigint NOT NULL DEFAULT 0,
	read_inbox_max_seq bigint NOT NULL DEFAULT 0,
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (chat_id, user_id, topic_id),
	FOREIGN KEY (chat_id, user_id) REFERENCES chat_members (chat_id, user_id) ON DELETE CASCADE
);

-- Messages are addressed by (chat_id, seq); id is the internal Snowflake key.
-- content holds the rich parts (entities, forward header, action, link
-- preview) as an encoded app.v1.Message.
CREATE TABLE messages (
	chat_id bigint NOT NULL,
	seq bigint NOT NULL,
	id bigint NOT NULL,
	topic_id bigint NOT NULL DEFAULT 0,
	from_id bigint NOT NULL,
	-- Client dedupe key of the sender (0 when none); shown to the sender only.
	random_id bigint NOT NULL DEFAULT 0,
	date timestamptz NOT NULL DEFAULT now(),
	text text NOT NULL DEFAULT '',
	content bytea,
	reply_to_seq bigint NOT NULL DEFAULT 0,
	grouped_id bigint NOT NULL DEFAULT 0,
	edit_version integer NOT NULL DEFAULT 0,
	edit_date timestamptz,
	-- Deleted for everyone: text and content are erased.
	deleted_at timestamptz,
	PRIMARY KEY (chat_id, seq)
) PARTITION BY HASH (chat_id);

-- +goose StatementBegin
DO $$
BEGIN
	FOR i IN 0..63 LOOP
		EXECUTE format('CREATE TABLE messages_p%s PARTITION OF messages FOR VALUES WITH (MODULUS 64, REMAINDER %s)', i, i);
	END LOOP;
END
$$;
-- +goose StatementEnd

CREATE INDEX messages_topic_idx ON messages (chat_id, topic_id, seq);
CREATE INDEX messages_id_idx ON messages (id);

-- random_id dedupe of sends (ADR 0001); kept 7 days. The ack is replayed to
-- a retry.
CREATE TABLE send_dedupe (
	sender_id bigint NOT NULL,
	random_id bigint NOT NULL,
	chat_id bigint NOT NULL,
	seq bigint NOT NULL,
	pts bigint NOT NULL DEFAULT 0,
	chat_pts bigint NOT NULL DEFAULT 0,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (sender_id, random_id)
);
CREATE INDEX send_dedupe_created_idx ON send_dedupe (created_at);

CREATE TABLE user_hidden_messages (
	user_id bigint NOT NULL,
	chat_id bigint NOT NULL,
	seq bigint NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (user_id, chat_id, seq)
);

-- One reaction per user and message.
CREATE TABLE message_reactions (
	chat_id bigint NOT NULL,
	seq bigint NOT NULL,
	user_id bigint NOT NULL,
	emoji text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (chat_id, seq, user_id)
);

CREATE TABLE pinned_messages (
	chat_id bigint NOT NULL,
	seq bigint NOT NULL,
	pinned_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (chat_id, seq)
);

-- Per-user log position (ADR 0002). Rows are created on a user's first update.
CREATE TABLE user_state (
	user_id bigint PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
	pts bigint NOT NULL DEFAULT 0 CHECK (pts >= 0 AND pts < 9007199254740992),
	updated_at timestamptz NOT NULL DEFAULT now()
);

-- Per-user update log. "update" is an encoded app.v1.Update without its
-- position fields; messages inside are reduced to (chat_id, seq) and rendered
-- from the messages table when read, so deleted content is never replayed.
CREATE TABLE user_updates (
	user_id bigint NOT NULL,
	pts bigint NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	chat_id bigint NOT NULL DEFAULT 0,
	"update" bytea NOT NULL
) PARTITION BY RANGE (created_at);
CREATE INDEX user_updates_pts_idx ON user_updates (user_id, pts);

-- Per-chat log of sync_mode=large chats, same encoding.
CREATE TABLE chat_updates (
	chat_id bigint NOT NULL,
	chat_pts bigint NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	"update" bytea NOT NULL
) PARTITION BY RANGE (created_at);
CREATE INDEX chat_updates_pts_idx ON chat_updates (chat_id, chat_pts);

-- Outbox (ADR 0003): one row per mutation, written in its transaction.
-- user_ids/pts list the per-user log entries it wrote (parallel arrays),
-- chat_pts the entries of chat_id's own log, so a consumer can replay a
-- dropped delivery.
CREATE TABLE outbox (
	id bigserial NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	kind text NOT NULL CHECK (kind IN ('message_new', 'message_edit', 'message_delete', 'message_hidden',
		'reaction', 'read', 'pin', 'member_added', 'member_removed', 'member_permissions',
		'chat_mode_changed', 'chat_updated', 'inline_button', 'session_revoked', 'topic_changed')),
	tenant_id text NOT NULL DEFAULT '',
	chat_id bigint NOT NULL DEFAULT 0,
	actor_id bigint NOT NULL DEFAULT 0,
	session_id bigint NOT NULL DEFAULT 0,
	-- session_revoked: app.v1.SessionRevokeReason.
	reason smallint NOT NULL DEFAULT 0,
	user_ids bigint[] NOT NULL DEFAULT '{}',
	pts bigint[] NOT NULL DEFAULT '{}',
	chat_pts bigint[] NOT NULL DEFAULT '{}'
) PARTITION BY RANGE (created_at);
CREATE INDEX outbox_id_idx ON outbox (id);

CREATE TABLE outbox_cursors (
	consumer text PRIMARY KEY,
	last_id bigint NOT NULL DEFAULT 0,
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invite_links (
	tenant_id text NOT NULL REFERENCES tenants (id),
	-- 128-bit random, base64url.
	token text NOT NULL CHECK (length(token) >= 22),
	chat_id bigint NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
	creator_id bigint NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	expires_at timestamptz,
	usage_limit integer NOT NULL DEFAULT 0 CHECK (usage_limit >= 0),
	usage_count integer NOT NULL DEFAULT 0,
	revoked_at timestamptz,
	PRIMARY KEY (tenant_id, token)
);
CREATE INDEX invite_links_chat_idx ON invite_links (chat_id);

-- Text-only Open Graph previews, cached per URL.
CREATE TABLE link_previews (
	url text PRIMARY KEY,
	ok boolean NOT NULL,
	site_name text NOT NULL DEFAULT '',
	title text NOT NULL DEFAULT '',
	description text NOT NULL DEFAULT '',
	fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX link_previews_fetched_idx ON link_previews (fetched_at);

-- Reports from users, the input of the moderation queue. evidence keeps the
-- reported messages as they were, in case they are deleted later.
CREATE TABLE reports (
	id bigserial PRIMARY KEY,
	tenant_id text NOT NULL REFERENCES tenants (id),
	reporter_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	target_user_id bigint NOT NULL DEFAULT 0,
	target_chat_id bigint NOT NULL DEFAULT 0,
	seqs bigint[] NOT NULL DEFAULT '{}',
	reason smallint NOT NULL,
	comment text NOT NULL DEFAULT '',
	evidence jsonb NOT NULL DEFAULT '[]',
	status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
	created_at timestamptz NOT NULL DEFAULT now(),
	resolved_at timestamptz,
	resolved_by text
);
CREATE INDEX reports_open_idx ON reports (tenant_id, created_at) WHERE status = 'open';

-- Creates the daily partitions of user_updates, chat_updates and outbox from
-- yesterday to days_ahead days ahead (UTC), and drops the ones whose day is
-- more than keep_days in the past.
-- +goose StatementBegin
CREATE FUNCTION chat_ensure_day_partitions(days_ahead integer, keep_days integer) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
	parent text;
	today date := (now() AT TIME ZONE 'UTC')::date;
	d date;
	part text;
BEGIN
	FOREACH parent IN ARRAY ARRAY['user_updates', 'chat_updates', 'outbox'] LOOP
		d := today - 1;
		WHILE d <= today + days_ahead LOOP
			part := parent || '_' || to_char(d, 'YYYYMMDD');
			IF to_regclass(part) IS NULL THEN
				EXECUTE format('CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
					part, parent, d::text || ' 00:00:00+00', (d + 1)::text || ' 00:00:00+00');
			END IF;
			d := d + 1;
		END LOOP;
		FOR part IN
			SELECT c.relname FROM pg_inherits i
			JOIN pg_class c ON c.oid = i.inhrelid
			JOIN pg_class p ON p.oid = i.inhparent
			WHERE p.relname = parent AND c.relname ~ ('^' || parent || '_[0-9]{8}$')
				AND to_date(right(c.relname, 8), 'YYYYMMDD') < today - keep_days
		LOOP
			EXECUTE format('DROP TABLE %I', part);
		END LOOP;
	END LOOP;
END
$$;
-- +goose StatementEnd

SELECT chat_ensure_day_partitions(30, 30);

-- Revoked sessions reach the realtime gateway through the outbox whatever
-- revoked them (sign-out, another session, back-channel logout, grant check).
ALTER TABLE user_sessions ADD COLUMN revoke_reason smallint;

-- +goose StatementBegin
CREATE FUNCTION chat_session_revoked() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	INSERT INTO outbox (kind, tenant_id, actor_id, session_id, reason)
	VALUES ('session_revoked', NEW.tenant_id, NEW.user_id, NEW.id, coalesce(NEW.revoke_reason, 0));
	RETURN NULL;
END
$$;
-- +goose StatementEnd

CREATE TRIGGER user_sessions_revoked AFTER UPDATE OF revoked_at ON user_sessions
	FOR EACH ROW WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
	EXECUTE FUNCTION chat_session_revoked();

-- +goose Down

DROP TRIGGER user_sessions_revoked ON user_sessions;
DROP FUNCTION chat_session_revoked();
ALTER TABLE user_sessions DROP COLUMN revoke_reason;
DROP FUNCTION chat_ensure_day_partitions(integer, integer);
DROP TABLE reports;
DROP TABLE link_previews;
DROP TABLE invite_links;
DROP TABLE outbox_cursors;
DROP TABLE outbox;
DROP TABLE chat_updates;
DROP TABLE user_updates;
DROP TABLE user_state;
DROP TABLE pinned_messages;
DROP TABLE message_reactions;
DROP TABLE user_hidden_messages;
DROP TABLE send_dedupe;
DROP TABLE messages;
DROP TABLE chat_read_states;
DROP TABLE forum_topics;
DROP TABLE chat_members;
DROP TABLE private_chats;
DROP TABLE chats;
DROP SEQUENCE chat_local_id_seq;
DROP TABLE blocks;
DROP TABLE privacy_settings;
ALTER TABLE users DROP COLUMN last_seen_at;
DROP TABLE snowflake_workers;
DROP TABLE server_meta;
