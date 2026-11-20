-- People (ADR 0025): the owner's own grouping of users that are the same
-- person on several apps. A person is a row of the owner that holds at least
-- two users: a Chat account and/or the puppet users of other apps synced
-- with the bridge. The contacts table and the bridge tables stay as they are.
--
-- people.name is fixed when the link is made and is never edited. A user is
-- in at most one person of an owner (UNIQUE (owner_id, user_id)); the
-- composite foreign key keeps a member row from naming a person of another
-- owner. Members go with their person.
--
-- people_rejections holds the pairs the owner said are not the same person,
-- so a suggestion is not shown again; the suggestions themselves are never
-- stored. user_a < user_b makes a pair one row.
--
-- Erasing an account deletes these rows in privacy/deletion.go, and removing
-- a bridge account detaches its puppets (bridge/engine/control.go); deleting
-- the user row cascades as a last resort.
--
-- outbox gets the kind people_changed: a hint without content that tells the
-- owner's other sessions to list their people again.
--
-- Expand-only: new tables and a wider CHECK; the previous binary ignores the
-- tables and never writes the new kind.

-- +goose Up

SET LOCAL lock_timeout = '5s';

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
-- Erasing or detaching a user finds the rows naming them.
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

ALTER TABLE outbox DROP CONSTRAINT outbox_kind_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_kind_check CHECK (kind IN ('message_new', 'message_edit', 'message_delete',
	'message_hidden', 'reaction', 'read', 'pin', 'member_added', 'member_removed', 'member_permissions',
	'chat_mode_changed', 'chat_updated', 'inline_button', 'session_revoked', 'topic_changed',
	'dialog_mute', 'pinned_dialogs', 'chat_deleted', 'dialog_unread_mark', 'notification_settings', 'inline_query',
	'user_changed', 'agent_projects_changed', 'advisor_profile', 'people_changed'));

-- +goose Down

SET LOCAL lock_timeout = '5s';

DELETE FROM outbox WHERE kind = 'people_changed';
ALTER TABLE outbox DROP CONSTRAINT outbox_kind_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_kind_check CHECK (kind IN ('message_new', 'message_edit', 'message_delete',
	'message_hidden', 'reaction', 'read', 'pin', 'member_added', 'member_removed', 'member_permissions',
	'chat_mode_changed', 'chat_updated', 'inline_button', 'session_revoked', 'topic_changed',
	'dialog_mute', 'pinned_dialogs', 'chat_deleted', 'dialog_unread_mark', 'notification_settings', 'inline_query',
	'user_changed', 'agent_projects_changed', 'advisor_profile'));
DROP TABLE people_rejections;
DROP TABLE people_members;
DROP TABLE people;
