-- Chat Bridge: a log of what Chat did to people and groups in another app (feature
-- members and the like): who asked, what, to whom, and how it ended. Rows are only
-- added. It holds ids and a short reason, never a message or a name.

-- +goose Up

SET LOCAL lock_timeout = '5s';

CREATE TABLE external_audit (
	id bigserial PRIMARY KEY,
	account_id bigint NOT NULL REFERENCES external_accounts (id) ON DELETE CASCADE,
	external_chat_id text NOT NULL,
	chat_id bigint NOT NULL,
	feature text NOT NULL,
	action text NOT NULL,
	target text NOT NULL DEFAULT '',
	actor_id bigint NOT NULL,
	result text NOT NULL CHECK (result IN ('sent', 'failed', 'limited')),
	detail text NOT NULL DEFAULT '' CHECK (octet_length(detail) <= 512),
	created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX external_audit_account_idx ON external_audit (account_id, feature, created_at DESC);

-- +goose Down

DROP TABLE external_audit;
