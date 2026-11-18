-- Chat Bridge, two-way (ADR 0022): the queue of what Chat sends to the other
-- app. A row is written in the transaction that writes the message, edit or
-- delete in Chat, so a message either exists with its row or not at all.
-- The row holds no content: the sender reads the message by (chat_id, seq)
-- when it is due, so an edit made before the send goes out is sent as is.
--
-- random_id is generated once and kept across retries; the other app answers
-- a repeated send with the message it already took (checked against Telegram
-- on 2026-11-18). It is 0 for edit and delete rows.
--
-- Expand-only: one new table; the previous binary ignores it.

-- +goose Up

SET LOCAL lock_timeout = '5s';

CREATE TABLE external_outbox (
	id bigserial PRIMARY KEY,
	account_id bigint NOT NULL,
	external_chat_id text NOT NULL,
	chat_id bigint NOT NULL,
	seq bigint NOT NULL,
	op text NOT NULL CHECK (op IN ('send', 'edit', 'delete')),
	random_id bigint NOT NULL DEFAULT 0,
	-- unknown: a send that was in flight too long ago to retry on its own;
	-- the user decides whether to send it again.
	status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled', 'unknown')),
	attempts integer NOT NULL DEFAULT 0,
	next_attempt_at timestamptz NOT NULL DEFAULT now(),
	last_error text NOT NULL DEFAULT '' CHECK (octet_length(last_error) <= 512),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	FOREIGN KEY (account_id, external_chat_id) REFERENCES external_chats (account_id, external_chat_id) ON DELETE CASCADE,
	UNIQUE (chat_id, seq, op)
);
-- What the sender of one account works through, oldest first.
CREATE INDEX external_outbox_due_idx ON external_outbox (account_id, id) WHERE status IN ('pending', 'sending');

-- +goose Down

SET LOCAL lock_timeout = '5s';

DROP TABLE external_outbox;
