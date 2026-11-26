-- A mention (or reply) of a user stays unread until that user sees the message itself, as in
-- Telegram: reading the chat past it elsewhere (another device, the other app of a synced
-- chat) does not clear it. unread_mentions_count counts the rows not read, and the client
-- jumps to them one by one.
--
-- Rows the user had already read past are marked read, so no old mention comes back.
-- Expand-only: a column with a default the previous binary never reads.

-- +goose Up

SET LOCAL lock_timeout = '5s';

ALTER TABLE message_mentions ADD COLUMN read boolean NOT NULL DEFAULT false;

UPDATE message_mentions mm SET read = true
FROM messages msg JOIN chats c ON c.id = msg.chat_id
WHERE msg.chat_id = mm.chat_id AND msg.seq = mm.seq
	AND EXISTS (SELECT 1 FROM chat_read_states r
		WHERE r.chat_id = mm.chat_id AND r.user_id = mm.user_id
			AND r.topic_id = CASE WHEN c.forum THEN msg.topic_id ELSE 0 END
			AND r.read_inbox_max_seq >= mm.seq);

-- +goose Down

SET LOCAL lock_timeout = '5s';

ALTER TABLE message_mentions DROP COLUMN read;
