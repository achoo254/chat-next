-- Chat Bridge: what a new synced chat of an account starts with, feature by feature
-- (the owner's choice for the account). A chat copies these when it is synced and keeps
-- its own settings afterwards; "apply to all" writes them to the chats already synced.
-- Acting on people and groups, and messages, are never defaults.

-- +goose Up

SET LOCAL lock_timeout = '5s';

CREATE TABLE external_feature_defaults (
	account_id bigint NOT NULL REFERENCES external_accounts (id) ON DELETE CASCADE,
	feature text NOT NULL CHECK (feature <> ''),
	direction text NOT NULL CHECK (direction IN ('off', 'in', 'out', 'both')),
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (account_id, feature)
);

-- +goose Down

DROP TABLE external_feature_defaults;
