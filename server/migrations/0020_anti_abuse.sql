-- Anti-abuse (Phase 12): limits on cold outreach, bot restriction and
-- review, moderation of webhooks, warnings and the moderation log screen.
-- Expand-only: indexes, nullable or defaulted columns, and wider CHECKs;
-- the previous binary ignores them. The tables are small at this stage, so
-- the indexes are built in the migration's transaction.

-- +goose Up

SET LOCAL lock_timeout = '5s';

-- chat.checkStrangerChat: the private chats a user started in the last day,
-- and the open reports against a user.
CREATE INDEX chats_private_creator_idx ON chats (creator_id, created_at) WHERE type = 'private';
CREATE INDEX reports_open_target_idx ON reports (tenant_id, target_user_id, created_at) WHERE status = 'open';

-- New log actions; operator_id 0 is an automatic rule. hook_id names the
-- webhook a disable_webhook entry turned off.
ALTER TABLE moderation_log DROP CONSTRAINT moderation_log_action_check;
ALTER TABLE moderation_log ADD CONSTRAINT moderation_log_action_check CHECK (action IN ('dismiss', 'delete_messages',
	'ban_from_chat', 'restrict_account', 'lift_restriction', 'warn', 'disable_webhook', 'restrict_bot', 'restore_bot_tier',
	'keep_bot_restricted', 'verify_bot', 'unverify_bot', 'limit_stranger_chats'));
ALTER TABLE moderation_log ADD COLUMN hook_id text NOT NULL DEFAULT '';
CREATE INDEX moderation_log_tenant_idx ON moderation_log (tenant_id, id DESC);

-- A moderation notice from the assistant opens its chat with the user
-- (source notice), so a user who never pressed Start still gets it.
ALTER TABLE bot_user_consent DROP CONSTRAINT bot_user_consent_source_check;
ALTER TABLE bot_user_consent ADD CONSTRAINT bot_user_consent_source_check
	CHECK (source IN ('start', 'deep_link', 'button', 'message', 'notice'));

ALTER TABLE incoming_hooks DROP CONSTRAINT incoming_hooks_disabled_reason_check;
ALTER TABLE incoming_hooks ADD CONSTRAINT incoming_hooks_disabled_reason_check
	CHECK (disabled_reason IN ('', 'by_admin', 'creator_not_admin', 'creator_left', 'by_moderator'));

-- Which hook posted each webhook message, so the moderation team turns off
-- that hook even when another hook has the same name or it was renamed.
-- No foreign key to incoming_hooks: a deleted hook's messages keep the id.
CREATE TABLE hook_posts (
	chat_id bigint NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
	seq bigint NOT NULL,
	hook_id text NOT NULL,
	PRIMARY KEY (chat_id, seq)
);

-- A restricted bot runs on the lowest rate tier. restricted_by 0 is the
-- automatic rule; an operator reviews it (keep: reviewed_at set; restore:
-- the columns are cleared).
ALTER TABLE bots
	ADD COLUMN restricted_at timestamptz,
	ADD COLUMN restricted_by bigint NOT NULL DEFAULT 0,
	ADD COLUMN restricted_reason text NOT NULL DEFAULT '',
	ADD COLUMN restriction_reviewed_at timestamptz;

-- +goose Down

-- The wider CHECKs of moderation_log, bot_user_consent and incoming_hooks
-- stay: narrowing them would rewrite moderation decisions (a hook turned off
-- by the moderation team would become one admins may turn back on) or drop
-- consents users gave since.
DROP TABLE hook_posts;
ALTER TABLE bots DROP COLUMN restriction_reviewed_at, DROP COLUMN restricted_reason, DROP COLUMN restricted_by,
	DROP COLUMN restricted_at;
DROP INDEX moderation_log_tenant_idx;
ALTER TABLE moderation_log DROP COLUMN hook_id;
DROP INDEX reports_open_target_idx;
DROP INDEX chats_private_creator_idx;
