-- Polls: outbox gets the kind poll, which tells members that the results of a poll
-- changed or that it closed (UpdatePoll).
--
-- No transaction: the wider check is added NOT VALID (a short lock, no
-- scan), validated on its own (the scan takes a lock that lets writes go
-- on), and only then replaces the old one. Each step can run again after a
-- failure.
--
-- Expand-only: the check only widens; the previous binary never writes the
-- new kind.

-- +goose NO TRANSACTION

-- +goose Up

SET lock_timeout = '5s';

ALTER TABLE outbox DROP CONSTRAINT IF EXISTS outbox_kind_check_next;
ALTER TABLE outbox ADD CONSTRAINT outbox_kind_check_next CHECK (kind IN ('message_new', 'message_edit', 'message_delete',
	'message_hidden', 'reaction', 'read', 'pin', 'member_added', 'member_removed', 'member_permissions',
	'chat_mode_changed', 'chat_updated', 'inline_button', 'session_revoked', 'topic_changed',
	'dialog_mute', 'pinned_dialogs', 'chat_deleted', 'dialog_unread_mark', 'notification_settings', 'inline_query',
	'user_changed', 'agent_projects_changed', 'advisor_profile', 'people_changed', 'dialog_hidden_from_ai', 'poll')) NOT VALID;
ALTER TABLE outbox VALIDATE CONSTRAINT outbox_kind_check_next;
ALTER TABLE outbox DROP CONSTRAINT IF EXISTS outbox_kind_check;
ALTER TABLE outbox RENAME CONSTRAINT outbox_kind_check_next TO outbox_kind_check;

RESET lock_timeout;

-- +goose Down

SET lock_timeout = '5s';

DELETE FROM outbox WHERE kind = 'poll';
ALTER TABLE outbox DROP CONSTRAINT IF EXISTS outbox_kind_check_next;
ALTER TABLE outbox ADD CONSTRAINT outbox_kind_check_next CHECK (kind IN ('message_new', 'message_edit', 'message_delete',
	'message_hidden', 'reaction', 'read', 'pin', 'member_added', 'member_removed', 'member_permissions',
	'chat_mode_changed', 'chat_updated', 'inline_button', 'session_revoked', 'topic_changed',
	'dialog_mute', 'pinned_dialogs', 'chat_deleted', 'dialog_unread_mark', 'notification_settings', 'inline_query',
	'user_changed', 'agent_projects_changed', 'advisor_profile', 'people_changed', 'dialog_hidden_from_ai')) NOT VALID;
ALTER TABLE outbox VALIDATE CONSTRAINT outbox_kind_check_next;
ALTER TABLE outbox DROP CONSTRAINT IF EXISTS outbox_kind_check;
ALTER TABLE outbox RENAME CONSTRAINT outbox_kind_check_next TO outbox_kind_check;

RESET lock_timeout;
