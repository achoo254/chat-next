-- Polls (Message.poll). What the sender posted (question, answers, flags) lives in the
-- message's content like any other content; what changes after (closed, the quiz answer,
-- the votes) lives here.
--
-- message_polls: one row per poll message.
--   correct / explanation: the right answers of a quiz and why, kept apart from the content
--     so they are only shown to who may see them; a quiz of another app tells them only
--     once the owner answered, so they may arrive later.
--   external_counts / external_voters: the results as the other app of a synced chat
--     tells them (everyone there, the owner included). NULL for a poll of Chat, whose
--     results are counted from poll_votes.
-- poll_votes: the answers of each person, as indexes into the poll's answers.
--
-- New tables only: the previous binary never reads them.

-- +goose Up

SET LOCAL lock_timeout = '5s';

CREATE TABLE message_polls (
	chat_id bigint NOT NULL,
	seq bigint NOT NULL,
	closed boolean NOT NULL DEFAULT false,
	correct smallint[] NOT NULL DEFAULT '{}',
	explanation text NOT NULL DEFAULT '',
	external_counts integer[],
	external_voters integer,
	PRIMARY KEY (chat_id, seq)
);

CREATE TABLE poll_votes (
	chat_id bigint NOT NULL,
	seq bigint NOT NULL,
	user_id bigint NOT NULL,
	options smallint[] NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (chat_id, seq, user_id)
);

-- +goose Down

DROP TABLE poll_votes;
DROP TABLE message_polls;
