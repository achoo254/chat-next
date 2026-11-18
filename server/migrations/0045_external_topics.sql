-- Chat Bridge, forum topics (ADR 0022): a forum conversation of the other app
-- becomes a forum group in Chat and each of its topics a Chat topic. The other
-- app's topic id is opaque text (Telegram uses the id of the message that opened
-- the topic: not consecutive, up to hundreds of thousands), the Chat topic id is
-- the group's own counter, so this table maps one to the other.
--
-- Expand-only: one new table; the previous binary ignores it.

-- +goose Up

SET LOCAL lock_timeout = '5s';

CREATE TABLE external_topics (
	account_id bigint NOT NULL,
	external_chat_id text NOT NULL,
	external_topic_id text NOT NULL,
	topic_id bigint NOT NULL,
	PRIMARY KEY (account_id, external_chat_id, external_topic_id),
	-- A topic of Chat stands for one topic of the other app only.
	UNIQUE (account_id, external_chat_id, topic_id),
	FOREIGN KEY (account_id, external_chat_id) REFERENCES external_chats (account_id, external_chat_id) ON DELETE CASCADE
);

-- +goose Down

SET LOCAL lock_timeout = '5s';

DROP TABLE external_topics;
