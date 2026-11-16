-- The Advisor profile of the AI Agent (AdvisorService): what the user calls
-- their Advisor mascot, how it looks and how it words its answers. Kept per
-- user and synced to every session like the notification settings; a user
-- without a row has the defaults (empty name, look 'owl', tone 1 short).
-- No secret, machine or AI is stored: the TypeSafe key stays on each
-- machine. tone follows app.v1.AdvisorTone: 1 short, 2 fun, 3 serious.
-- Erasing an account deletes its row (trigger below), and deleting the user
-- row cascades.
--
-- outbox gets the kind advisor_profile: the whole profile for the owner's
-- other sessions.
--
-- Expand-only: a new table, function and trigger, and a wider CHECK; the
-- previous binary ignores the table and never writes the new kind.

-- +goose Up

SET LOCAL lock_timeout = '5s';

CREATE TABLE advisor_profiles (
	user_id bigint PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
	-- At most 32 characters (the service checks): 128 bytes in any encoding.
	name text NOT NULL DEFAULT '' CHECK (octet_length(name) <= 128),
	look_id text NOT NULL DEFAULT 'owl' CHECK (look_id ~ '^[a-z][a-z0-9-]{0,31}$'),
	tone smallint NOT NULL DEFAULT 1 CHECK (tone BETWEEN 1 AND 3),
	updated_at timestamptz NOT NULL DEFAULT now()
);

-- +goose StatementBegin
CREATE FUNCTION advisor_profiles_user_erased() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	DELETE FROM advisor_profiles WHERE user_id = NEW.id;
	RETURN NULL;
END
$$;
-- +goose StatementEnd

CREATE TRIGGER users_erased_advisor_profiles AFTER UPDATE OF deleted_at ON users
	FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
	EXECUTE FUNCTION advisor_profiles_user_erased();

ALTER TABLE outbox DROP CONSTRAINT outbox_kind_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_kind_check CHECK (kind IN ('message_new', 'message_edit', 'message_delete',
	'message_hidden', 'reaction', 'read', 'pin', 'member_added', 'member_removed', 'member_permissions',
	'chat_mode_changed', 'chat_updated', 'inline_button', 'session_revoked', 'topic_changed',
	'dialog_mute', 'pinned_dialogs', 'chat_deleted', 'dialog_unread_mark', 'notification_settings', 'inline_query',
	'user_changed', 'agent_projects_changed', 'advisor_profile'));

-- +goose Down

SET LOCAL lock_timeout = '5s';

DELETE FROM outbox WHERE kind = 'advisor_profile';
ALTER TABLE outbox DROP CONSTRAINT outbox_kind_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_kind_check CHECK (kind IN ('message_new', 'message_edit', 'message_delete',
	'message_hidden', 'reaction', 'read', 'pin', 'member_added', 'member_removed', 'member_permissions',
	'chat_mode_changed', 'chat_updated', 'inline_button', 'session_revoked', 'topic_changed',
	'dialog_mute', 'pinned_dialogs', 'chat_deleted', 'dialog_unread_mark', 'notification_settings', 'inline_query',
	'user_changed', 'agent_projects_changed'));
DROP TRIGGER users_erased_advisor_profiles ON users;
DROP FUNCTION advisor_profiles_user_erased();
DROP TABLE advisor_profiles;
