-- AI in conversations: messages.via_ai records that the sender posted the
-- message with an MCP tool; only the sender sees it (Message.sent_via_ai).
--
-- One table per migration: a constant default needs no rewrite, so the
-- lock on messages (and its partitions) is short.
--
-- Expand-only: the previous binary neither reads nor writes the column.

-- +goose Up

SET LOCAL lock_timeout = '5s';

ALTER TABLE messages
	ADD COLUMN via_ai boolean NOT NULL DEFAULT false;

-- +goose Down

SET LOCAL lock_timeout = '5s';

ALTER TABLE messages DROP COLUMN via_ai;
