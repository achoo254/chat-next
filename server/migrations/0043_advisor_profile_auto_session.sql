-- The user's wish for automatic Advisor in every session (AdvisorProfile.auto_session),
-- kept with the rest of the Advisor profile: off for a user who never changed it.
-- Each machine keeps its own switch (AdvisorSetAuto); a device brings the machine in
-- line with this one when it links to it.
--
-- Expand-only: a new column with a default; the previous binary neither reads nor writes it.

-- +goose Up

SET LOCAL lock_timeout = '5s';

ALTER TABLE advisor_profiles ADD COLUMN auto_session boolean NOT NULL DEFAULT false;

-- +goose Down

SET LOCAL lock_timeout = '5s';

ALTER TABLE advisor_profiles DROP COLUMN auto_session;
