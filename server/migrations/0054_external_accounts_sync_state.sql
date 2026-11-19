-- Chat Bridge: one switch per account (ADR 0024). sync_state says whether every
-- conversation of the account is synced: off (not asked yet, or declined), syncing (the
-- first import of each conversation is running) or live (all imported, new ones join on
-- their own). Every feature now follows the chat's own direction, so the per-chat and
-- per-account choices go: their rows are emptied here and their tables dropped once the
-- calls that wrote them are gone. Linked chats of a connected account become two-way.
--
-- The deploy backs the database up before migrating (activate-release.sh).

-- +goose Up

SET LOCAL lock_timeout = '5s';

ALTER TABLE external_accounts ADD COLUMN sync_state text NOT NULL DEFAULT 'off'
	CHECK (sync_state IN ('off', 'syncing', 'live'));

UPDATE external_chats x SET direction = 'both'
FROM external_accounts a WHERE a.id = x.account_id AND a.status <> 'stopped' AND x.direction <> 'both';

DELETE FROM external_chat_features;
DELETE FROM external_feature_defaults;

-- +goose Down

SET LOCAL lock_timeout = '5s';

ALTER TABLE external_accounts DROP COLUMN sync_state;
