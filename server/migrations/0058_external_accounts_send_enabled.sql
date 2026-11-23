-- Chat Bridge: send_enabled is the owner's switch for writing to the other app with
-- this account, for an app whose adapter gates sending per account (bridge.SendGated).
-- It is off until the owner turns it on; while off, the chats of such an account stay
-- receive-only and nothing queued goes out. Apps that are not gated ignore it, so no
-- row is turned on here.
--
-- Expand-only: a new column with a default; the previous binary neither reads nor writes it.

-- +goose Up

SET LOCAL lock_timeout = '5s';

ALTER TABLE external_accounts ADD COLUMN send_enabled boolean NOT NULL DEFAULT false;

-- +goose Down

SET LOCAL lock_timeout = '5s';

ALTER TABLE external_accounts DROP COLUMN send_enabled;
