-- How the other app states a puppet's presence, so Chat shows it as that app does: the band
-- when the person hides the exact time (0 exact, 1 recently, 2 within a week, 3 within a
-- month; users.last_seen_at then holds a time inside the band) and, while the app says the
-- person is online, when that lapses without a new status.
--
-- Expand-only: columns the previous binary neither reads nor writes.

-- +goose Up

SET LOCAL lock_timeout = '5s';

ALTER TABLE external_users
	ADD COLUMN seen_band smallint NOT NULL DEFAULT 0,
	ADD COLUMN online_until timestamptz;

-- +goose Down

SET LOCAL lock_timeout = '5s';

ALTER TABLE external_users
	DROP COLUMN online_until,
	DROP COLUMN seen_band;
