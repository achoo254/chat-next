-- The per-user "marked as unread" flag of a dialog and per-user
-- notification settings. (Several pinned messages per chat need no schema
-- change: pinned_messages is keyed by (chat_id, seq) already.)
-- Expand-only: the previous binary keeps working on this schema (the new
-- column has a default, the new table is unknown to it, and the outbox
-- check only widens).

-- +goose Up

-- unread_mark: the member marked the chat as unread; reading it clears it.
ALTER TABLE chat_members ADD COLUMN unread_mark boolean NOT NULL DEFAULT false;

-- Notification settings per user; a user without a row has the defaults
-- below. sound follows app.v1.NotificationSound: 1 default, 2 soft, 3 off.
CREATE TABLE notification_settings (
	user_id bigint PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
	private_enabled boolean NOT NULL DEFAULT true,
	private_preview boolean NOT NULL DEFAULT true,
	groups_enabled boolean NOT NULL DEFAULT true,
	groups_preview boolean NOT NULL DEFAULT true,
	channels_enabled boolean NOT NULL DEFAULT true,
	channels_preview boolean NOT NULL DEFAULT true,
	sound smallint NOT NULL DEFAULT 1 CHECK (sound BETWEEN 1 AND 3),
	badge_muted boolean NOT NULL DEFAULT false,
	updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE outbox DROP CONSTRAINT outbox_kind_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_kind_check CHECK (kind IN ('message_new', 'message_edit', 'message_delete',
	'message_hidden', 'reaction', 'read', 'pin', 'member_added', 'member_removed', 'member_permissions',
	'chat_mode_changed', 'chat_updated', 'inline_button', 'session_revoked', 'topic_changed',
	'dialog_mute', 'pinned_dialogs', 'chat_deleted', 'dialog_unread_mark', 'notification_settings'));

-- +goose Down

DELETE FROM outbox WHERE kind IN ('dialog_unread_mark', 'notification_settings');
ALTER TABLE outbox DROP CONSTRAINT outbox_kind_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_kind_check CHECK (kind IN ('message_new', 'message_edit', 'message_delete',
	'message_hidden', 'reaction', 'read', 'pin', 'member_added', 'member_removed', 'member_permissions',
	'chat_mode_changed', 'chat_updated', 'inline_button', 'session_revoked', 'topic_changed',
	'dialog_mute', 'pinned_dialogs', 'chat_deleted'));
DROP TABLE notification_settings;
ALTER TABLE chat_members DROP COLUMN unread_mark;
