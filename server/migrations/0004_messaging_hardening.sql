-- Contacts, bans, what members who left may still see, and log partition
-- maintenance that never holds a lock on a parent table across a drop.
-- Expand-only: the previous binary keeps working on this schema (it ignores
-- the new columns and still calls chat_ensure_day_partitions, kept as is).

-- +goose Up

-- A user's own contact list. Privacy audience CONTACTS of a user means the
-- users in that user's list (owner_id = the user).
CREATE TABLE contacts (
	tenant_id text NOT NULL REFERENCES tenants (id),
	owner_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	contact_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (owner_id, contact_id),
	CHECK (owner_id <> contact_id)
);
-- "Who has me in their list" (privacy checks run from the viewer's side).
CREATE INDEX contacts_contact_idx ON contacts (contact_id, owner_id);

-- left_seq: chats.last_seq when the member left; a former member sees
-- nothing newer, and nothing changed after left_at.
-- banned_at/banned_by: removed by an admin; no rejoining through invite
-- links, nor being added back by a non-admin, until an admin unbans.
ALTER TABLE chat_members
	ADD COLUMN left_seq bigint,
	ADD COLUMN banned_at timestamptz,
	ADD COLUMN banned_by bigint;
CREATE INDEX chat_members_banned_idx ON chat_members (chat_id, user_id) WHERE banned_at IS NOT NULL;

-- Members who left before this migration: the newest message at the time.
UPDATE chat_members m SET left_seq = coalesce(
	(SELECT max(msg.seq) FROM messages msg WHERE msg.chat_id = m.chat_id AND msg.date <= m.left_at), 0)
WHERE m.left_at IS NOT NULL;

-- When the content of a message last changed after it was posted (edit or
-- link preview); NULL when never.
ALTER TABLE messages ADD COLUMN changed_at timestamptz;

-- Forum topics: an icon glyph name and the number of live messages.
ALTER TABLE forum_topics
	ADD COLUMN icon text NOT NULL DEFAULT '' CHECK (icon ~ '^([a-z][a-z0-9-]{0,31})?$'),
	ADD COLUMN message_count integer NOT NULL DEFAULT 0;
UPDATE forum_topics t SET message_count = (
	SELECT count(*) FROM messages msg WHERE msg.chat_id = t.chat_id AND msg.topic_id = t.id AND msg.deleted_at IS NULL);

-- Who a message mentions (@username, a mention by id) or replies to, among
-- the chat's members when it was posted or edited; the source of
-- unread_mentions_count. Messages from before this table count none.
CREATE TABLE message_mentions (
	user_id bigint NOT NULL,
	chat_id bigint NOT NULL,
	seq bigint NOT NULL,
	PRIMARY KEY (user_id, chat_id, seq)
);
CREATE INDEX message_mentions_message_idx ON message_mentions (chat_id, seq);

-- When a read position moved, in groups small enough for read receipts;
-- kept as long as receipts are (GetMessageReaders read dates).
CREATE TABLE read_receipts (
	chat_id bigint NOT NULL,
	topic_id bigint NOT NULL,
	user_id bigint NOT NULL,
	max_seq bigint NOT NULL,
	read_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (chat_id, topic_id, max_seq, user_id)
);
CREATE INDEX read_receipts_read_at_idx ON read_receipts (read_at);

-- PrivatePeers looks a user up on either side of the pair.
CREATE INDEX private_chats_high_idx ON private_chats (tenant_id, user_high);

-- Creates the daily partitions of user_updates, chat_updates and outbox from
-- yesterday to days_ahead days ahead (UTC). Dropping old partitions is
-- separate (chat_expired_day_partitions), so this transaction only ever
-- creates.
-- +goose StatementBegin
CREATE FUNCTION chat_create_day_partitions(days_ahead integer) RETURNS void
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
	END LOOP;
END
$$;
-- +goose StatementEnd

-- How many days after today (UTC) every partitioned log covers without a
-- gap; writes fail once a day has no partition.
-- +goose StatementBegin
CREATE FUNCTION chat_day_partitions_ahead() RETURNS integer
LANGUAGE plpgsql STABLE AS $$
DECLARE
	parent text;
	today date := (now() AT TIME ZONE 'UTC')::date;
	covered integer;
	least_covered integer;
BEGIN
	FOREACH parent IN ARRAY ARRAY['user_updates', 'chat_updates', 'outbox'] LOOP
		covered := 0;
		WHILE covered < 3660
			AND to_regclass(parent || '_' || to_char(today + covered + 1, 'YYYYMMDD')) IS NOT NULL LOOP
			covered := covered + 1;
		END LOOP;
		least_covered := least(coalesce(least_covered, covered), covered);
	END LOOP;
	RETURN least_covered;
END
$$;
-- +goose StatementEnd

-- Daily partitions whose day is more than keep_days in the past, with their
-- state: attached (detach with DETACH PARTITION ... CONCURRENTLY, which
-- cannot run inside a transaction or a function), pending (a concurrent
-- detach was interrupted: FINALIZE it) or detached (only the DROP is left).
-- +goose StatementBegin
CREATE FUNCTION chat_expired_day_partitions(keep_days integer)
RETURNS TABLE (parent text, part text, state text)
LANGUAGE sql STABLE AS $$
	SELECT p.relname::text, c.relname::text, CASE WHEN i.inhdetachpending THEN 'pending' ELSE 'attached' END
	FROM pg_inherits i
	JOIN pg_class c ON c.oid = i.inhrelid
	JOIN pg_class p ON p.oid = i.inhparent
	WHERE p.relname IN ('user_updates', 'chat_updates', 'outbox') AND pg_table_is_visible(p.oid)
		AND c.relname ~ ('^' || p.relname || '_[0-9]{8}$')
		AND to_date(right(c.relname, 8), 'YYYYMMDD') < (now() AT TIME ZONE 'UTC')::date - keep_days
	UNION ALL
	SELECT left(c.relname, length(c.relname) - 9), c.relname::text, 'detached'
	FROM pg_class c
	WHERE c.relkind = 'r' AND NOT c.relispartition AND pg_table_is_visible(c.oid)
		AND c.relname ~ '^(user_updates|chat_updates|outbox)_[0-9]{8}$'
		AND to_date(right(c.relname, 8), 'YYYYMMDD') < (now() AT TIME ZONE 'UTC')::date - keep_days
	ORDER BY 2
$$;
-- +goose StatementEnd

-- +goose Down

DROP FUNCTION chat_expired_day_partitions(integer);
DROP FUNCTION chat_day_partitions_ahead();
DROP FUNCTION chat_create_day_partitions(integer);
DROP INDEX private_chats_high_idx;
DROP TABLE read_receipts;
DROP TABLE message_mentions;
ALTER TABLE forum_topics DROP COLUMN message_count, DROP COLUMN icon;
ALTER TABLE messages DROP COLUMN changed_at;
DROP INDEX chat_members_banned_idx;
ALTER TABLE chat_members DROP COLUMN banned_by, DROP COLUMN banned_at, DROP COLUMN left_seq;
DROP TABLE contacts;
