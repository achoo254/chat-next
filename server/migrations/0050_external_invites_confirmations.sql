-- Chat Bridge: the invite links of a group in the other app (not Chat's own links),
-- read from it and shown in Chat; and the second confirmation a final action asks for
-- (deleting a group): a token made by the first request, valid from a few seconds after
-- it was made until a few minutes, and used once.

-- +goose Up

SET LOCAL lock_timeout = '5s';

CREATE TABLE external_invites (
	account_id bigint NOT NULL,
	external_chat_id text NOT NULL,
	link text NOT NULL,
	title text NOT NULL DEFAULT '',
	revoked boolean NOT NULL DEFAULT false,
	usage integer NOT NULL DEFAULT 0,
	seen_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (account_id, external_chat_id, link),
	FOREIGN KEY (account_id, external_chat_id) REFERENCES external_chats (account_id, external_chat_id) ON DELETE CASCADE
);

CREATE TABLE external_confirmations (
	token text PRIMARY KEY,
	account_id bigint NOT NULL REFERENCES external_accounts (id) ON DELETE CASCADE,
	external_chat_id text NOT NULL,
	action text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	used_at timestamptz
);
CREATE INDEX external_confirmations_account_idx ON external_confirmations (account_id, created_at DESC);

-- A final action is logged before it is sent: a row "started", then its outcome.
ALTER TABLE external_audit DROP CONSTRAINT external_audit_result_check;
ALTER TABLE external_audit ADD CONSTRAINT external_audit_result_check CHECK (result IN ('started', 'sent', 'failed', 'limited'));

-- +goose Down

DELETE FROM external_audit WHERE result = 'started';
ALTER TABLE external_audit DROP CONSTRAINT external_audit_result_check;
ALTER TABLE external_audit ADD CONSTRAINT external_audit_result_check CHECK (result IN ('sent', 'failed', 'limited'));

DROP TABLE external_confirmations;
DROP TABLE external_invites;
