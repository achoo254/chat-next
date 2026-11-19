-- Chat Bridge: the per-account defaults of each feature are gone with the one-switch
-- sync (ADR 0024); every feature follows its chat. The table was emptied by 0054 and no
-- code reads it since.
--
-- The deploy backs the database up before migrating (activate-release.sh).

-- +goose Up

SET LOCAL lock_timeout = '5s';

DROP TABLE external_feature_defaults;

-- +goose Down

SET LOCAL lock_timeout = '5s';

CREATE TABLE external_feature_defaults (
	account_id bigint NOT NULL REFERENCES external_accounts(id) ON DELETE CASCADE,
	feature text NOT NULL CHECK (feature <> ''),
	direction text NOT NULL CHECK (direction IN ('off', 'in', 'out', 'both')),
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (account_id, feature)
);
