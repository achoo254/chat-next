-- When the user last removed the account's TypeSafe key (AdvisorProfile.key_removed_at),
-- in Unix milliseconds of a device's clock; 0 when never. No secret: the key itself
-- stays on the user's machines. A device removes every account key set no later than
-- this from the machines it links to, and never hands such a key on.
--
-- Expand-only: a new column with a default; the previous binary neither reads nor writes it.

-- +goose Up

SET LOCAL lock_timeout = '5s';

ALTER TABLE advisor_profiles ADD COLUMN key_removed_at bigint NOT NULL DEFAULT 0;

-- +goose Down

SET LOCAL lock_timeout = '5s';

ALTER TABLE advisor_profiles DROP COLUMN key_removed_at;
