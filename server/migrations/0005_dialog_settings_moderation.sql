-- Per-user dialog settings (mute, pinned chats), deleting chats, and the
-- moderation queue (account restrictions and an append-only log).
-- Expand-only: the previous binary keeps working on this schema (new columns
-- have defaults, new outbox kinds only widen the check, and a deleted chat
-- has no member rows left, which every older query already respects).

-- +goose Up

-- mute_until: unix seconds; 0 = not muted, 2147483647 = until unmuted.
-- pin_rank: position among the user's pinned chats (higher = nearer the
-- top); NULL = not pinned.
ALTER TABLE chat_members
	ADD COLUMN mute_until bigint NOT NULL DEFAULT 0 CHECK (mute_until >= 0 AND mute_until <= 2147483647),
	ADD COLUMN pin_rank integer;
CREATE INDEX chat_members_pinned_idx ON chat_members (user_id, pin_rank) WHERE pin_rank IS NOT NULL AND left_at IS NULL;

-- deleted_at: deleted for everyone by its owner (its member rows are gone at
-- once). purged_at: its messages and their side tables were removed.
ALTER TABLE chats
	ADD COLUMN deleted_at timestamptz,
	ADD COLUMN purged_at timestamptz;
CREATE INDEX chats_unpurged_idx ON chats (deleted_at) WHERE deleted_at IS NOT NULL AND purged_at IS NULL;

ALTER TABLE outbox DROP CONSTRAINT outbox_kind_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_kind_check CHECK (kind IN ('message_new', 'message_edit', 'message_delete',
	'message_hidden', 'reaction', 'read', 'pin', 'member_added', 'member_removed', 'member_permissions',
	'chat_mode_changed', 'chat_updated', 'inline_button', 'session_revoked', 'topic_changed',
	'dialog_mute', 'pinned_dialogs', 'chat_deleted'));

-- Reaction lists page newest first per message.
CREATE INDEX message_reactions_list_idx ON message_reactions (chat_id, seq, created_at DESC, user_id DESC);

-- Blocked users page newest first.
CREATE INDEX blocks_list_idx ON blocks (blocker_id, created_at DESC, blocked_id DESC);

-- Account restrictions set by operators. until NULL = until lifted.
CREATE TABLE account_restrictions (
	user_id bigint PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
	tenant_id text NOT NULL REFERENCES tenants (id),
	until timestamptz,
	reason text NOT NULL DEFAULT '',
	restricted_by bigint NOT NULL,
	report_id bigint,
	created_at timestamptz NOT NULL DEFAULT now()
);

-- Every moderation action, append-only.
CREATE TABLE moderation_log (
	id bigserial PRIMARY KEY,
	tenant_id text NOT NULL REFERENCES tenants (id),
	operator_id bigint NOT NULL,
	report_id bigint NOT NULL DEFAULT 0,
	action text NOT NULL CHECK (action IN ('dismiss', 'delete_messages', 'ban_from_chat', 'restrict_account', 'lift_restriction')),
	target_user_id bigint NOT NULL DEFAULT 0,
	target_chat_id bigint NOT NULL DEFAULT 0,
	seqs bigint[] NOT NULL DEFAULT '{}',
	note text NOT NULL DEFAULT '',
	until timestamptz,
	created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX moderation_log_target_idx ON moderation_log (tenant_id, target_user_id, id DESC);

-- +goose StatementBegin
CREATE FUNCTION moderation_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'moderation_log is append-only';
END
$$;
-- +goose StatementEnd

CREATE TRIGGER moderation_log_no_change BEFORE UPDATE OR DELETE ON moderation_log
	FOR EACH ROW EXECUTE FUNCTION moderation_log_append_only();

-- How a report was closed.
ALTER TABLE reports
	ADD COLUMN actions text[] NOT NULL DEFAULT '{}',
	ADD COLUMN resolution_note text NOT NULL DEFAULT '';
CREATE INDEX reports_tenant_idx ON reports (tenant_id, id DESC);

-- +goose Down

DROP INDEX reports_tenant_idx;
ALTER TABLE reports DROP COLUMN resolution_note, DROP COLUMN actions;
DROP TRIGGER moderation_log_no_change ON moderation_log;
DROP FUNCTION moderation_log_append_only();
DROP TABLE moderation_log;
DROP TABLE account_restrictions;
DROP INDEX blocks_list_idx;
DROP INDEX message_reactions_list_idx;
DELETE FROM outbox WHERE kind IN ('dialog_mute', 'pinned_dialogs', 'chat_deleted');
ALTER TABLE outbox DROP CONSTRAINT outbox_kind_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_kind_check CHECK (kind IN ('message_new', 'message_edit', 'message_delete',
	'message_hidden', 'reaction', 'read', 'pin', 'member_added', 'member_removed', 'member_permissions',
	'chat_mode_changed', 'chat_updated', 'inline_button', 'session_revoked', 'topic_changed'));
DROP INDEX chats_unpurged_idx;
ALTER TABLE chats DROP COLUMN purged_at, DROP COLUMN deleted_at;
DROP INDEX chat_members_pinned_idx;
ALTER TABLE chat_members DROP COLUMN pin_rank, DROP COLUMN mute_until;
