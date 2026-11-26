-- People (linking users of several apps into one person) is gone: no binary reads or writes its
-- tables or the phone hashes that only fed its suggestions, so they are dropped. This is the
-- contract step of the expand-only migrations 0057 and 0062, which added them.
--
-- Dropped: people, people_members, people_rejections (the owner's links, the name pinned at the
-- link and the pairs the owner refused), external_users.phone_hmac (the keyed hash of the number
-- another app showed for a person) and external_accounts.phone_book_read_at.
-- Kept: users.phone_hmac and its index (finding a person by phone, migration 0066) and the
-- outbox kind people_changed in the outbox CHECK: no row of that kind is written any more, and
-- narrowing the CHECK would scan every partition of a hot table for nothing.
--
-- The release before this one no longer names these tables (account erasure stopped deleting
-- from them), so it still runs on the new schema; rolling the code back needs no data change.
-- Down recreates the empty tables and columns; the rows and hashes are not restored. The deploy
-- backs the database up before it migrates (infra/chat/activate-release.sh).

-- +goose Up

SET LOCAL lock_timeout = '5s';

DROP TABLE people_rejections;
DROP TABLE people_members;
DROP TABLE people;

ALTER TABLE external_users
	DROP COLUMN phone_hmac;

ALTER TABLE external_accounts
	DROP COLUMN phone_book_read_at;

-- +goose Down

SET LOCAL lock_timeout = '5s';

ALTER TABLE external_accounts
	ADD COLUMN phone_book_read_at timestamptz;

ALTER TABLE external_users
	ADD COLUMN phone_hmac bytea CHECK (phone_hmac IS NULL OR octet_length(phone_hmac) = 32);

CREATE TABLE people (
	id bigserial PRIMARY KEY,
	owner_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	name text NOT NULL CHECK (octet_length(name) <= 256),
	created_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (id, owner_id)
);
CREATE INDEX people_owner_idx ON people (owner_id);

CREATE TABLE people_members (
	person_id bigint NOT NULL,
	owner_id bigint NOT NULL,
	user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (person_id, user_id),
	UNIQUE (owner_id, user_id),
	FOREIGN KEY (person_id, owner_id) REFERENCES people (id, owner_id) ON DELETE CASCADE
);
CREATE INDEX people_members_user_idx ON people_members (user_id);

CREATE TABLE people_rejections (
	owner_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	user_a bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	user_b bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (owner_id, user_a, user_b),
	CHECK (user_a < user_b)
);
CREATE INDEX people_rejections_user_idx ON people_rejections (user_a);
CREATE INDEX people_rejections_user_b_idx ON people_rejections (user_b);
