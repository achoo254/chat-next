-- The agent no longer reports one AI's version in its heartbeat: a machine
-- runs several AIs, and devices read each AI's version from the machine
-- itself (MachineInfo.providers) over the end-to-end link. The column goes.
-- Contract-only: the binary of this release neither reads nor writes it.

-- +goose Up

SET LOCAL lock_timeout = '5s';

ALTER TABLE machines DROP COLUMN claude_version;

-- +goose Down

SET LOCAL lock_timeout = '5s';

ALTER TABLE machines ADD COLUMN claude_version text NOT NULL DEFAULT '' CHECK (char_length(claude_version) <= 64);
