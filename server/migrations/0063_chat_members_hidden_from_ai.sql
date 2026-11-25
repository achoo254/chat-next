-- AI in conversations: a member can hide a chat from AI. hidden_from_ai is
-- the member's own setting; while it is set the MCP endpoint neither lists
-- nor reads nor writes the chat for that member. It stays when the member
-- leaves (and rejoins), so a chat once hidden never shows up for AI.
--
-- No transaction: the column is added on its own (a short lock, the default
-- needs no rewrite), then the index is built CONCURRENTLY so writes to
-- chat_members never wait for it. Each step can run again after a failure.
--
-- Expand-only: the previous binary neither reads nor writes the column.

-- +goose NO TRANSACTION

-- +goose Up

SET lock_timeout = '5s';

ALTER TABLE chat_members
	ADD COLUMN IF NOT EXISTS hidden_from_ai boolean NOT NULL DEFAULT false;

-- The chats a user hid, left ones included (few rows, so a small index).
-- A build that failed half way leaves an invalid index: drop it first.
DROP INDEX CONCURRENTLY IF EXISTS chat_members_hidden_from_ai_idx;
CREATE INDEX CONCURRENTLY chat_members_hidden_from_ai_idx ON chat_members (user_id, chat_id) WHERE hidden_from_ai;

RESET lock_timeout;

-- +goose Down

SET lock_timeout = '5s';

DROP INDEX CONCURRENTLY IF EXISTS chat_members_hidden_from_ai_idx;
ALTER TABLE chat_members DROP COLUMN IF EXISTS hidden_from_ai;

RESET lock_timeout;
