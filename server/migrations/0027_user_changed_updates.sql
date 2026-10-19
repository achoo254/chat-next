-- user_changed: members of a person's groups and channels learn that the
-- account waits for deletion, was restored or erased. Expand-only: a wider
-- CHECK; the previous binary never writes the new kind.

-- +goose Up

SET LOCAL lock_timeout = '5s';

ALTER TABLE outbox DROP CONSTRAINT outbox_kind_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_kind_check CHECK (kind IN ('message_new', 'message_edit', 'message_delete',
	'message_hidden', 'reaction', 'read', 'pin', 'member_added', 'member_removed', 'member_permissions',
	'chat_mode_changed', 'chat_updated', 'inline_button', 'session_revoked', 'topic_changed',
	'dialog_mute', 'pinned_dialogs', 'chat_deleted', 'dialog_unread_mark', 'notification_settings', 'inline_query',
	'user_changed'));

-- +goose Down

DELETE FROM outbox WHERE kind = 'user_changed';
ALTER TABLE outbox DROP CONSTRAINT outbox_kind_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_kind_check CHECK (kind IN ('message_new', 'message_edit', 'message_delete',
	'message_hidden', 'reaction', 'read', 'pin', 'member_added', 'member_removed', 'member_permissions',
	'chat_mode_changed', 'chat_updated', 'inline_button', 'session_revoked', 'topic_changed',
	'dialog_mute', 'pinned_dialogs', 'chat_deleted', 'dialog_unread_mark', 'notification_settings', 'inline_query'));
