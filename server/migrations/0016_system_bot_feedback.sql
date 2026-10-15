-- The official assistant bot of each tenant and the feedback users send it
-- (release R5). The assistant is a bot like any other (users row with
-- is_bot, bots row) marked is_system: it has no human owner (owner_id is
-- the bot itself, so it never counts toward a user's bot limit and the
-- Developer Console never lists it), no token, and its logic runs inside
-- the api process through the Bot API core. Feedback sent to it waits in
-- the operators' moderation queue next to reports.
-- Expand-only: the previous binary ignores the new column and table; the
-- assistant's bots row is a valid bot row for it (owner_id is set).

-- +goose Up

SET LOCAL lock_timeout = '5s';

ALTER TABLE bots ADD COLUMN is_system boolean NOT NULL DEFAULT false;
-- One assistant per tenant.
CREATE UNIQUE INDEX bots_system_idx ON bots (tenant_id) WHERE is_system;

CREATE TABLE feedback (
	id bigserial PRIMARY KEY,
	tenant_id text NOT NULL REFERENCES tenants (id),
	user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	-- idea: "Góp ý"; bug: "Báo lỗi".
	kind text NOT NULL CHECK (kind IN ('idea', 'bug')),
	text text NOT NULL,
	-- The user's message in the private chat with the assistant; replies
	-- quote it. Unique, so an update handled twice records it once.
	chat_id bigint NOT NULL,
	seq bigint NOT NULL,
	status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'handled')),
	created_at timestamptz NOT NULL DEFAULT now(),
	handled_at timestamptz,
	handled_by bigint,
	-- The operator's answer, sent to the user by the assistant (one per item).
	reply_text text NOT NULL DEFAULT '',
	replied_at timestamptz,
	replied_by bigint,
	CONSTRAINT feedback_message_key UNIQUE (chat_id, seq)
);
CREATE INDEX feedback_queue_idx ON feedback (tenant_id, status, id);

-- +goose Down

DROP TABLE feedback;
DROP INDEX bots_system_idx;
ALTER TABLE bots DROP COLUMN is_system;
