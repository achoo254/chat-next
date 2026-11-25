-- Chat Bridge: a keyed hash of the phone number the other app shows for a person, so two
-- puppets of the same owner with the same number can be suggested as one person (ADR 0025).
-- phone_hmac is HMAC-SHA256 of the E.164 number under BRIDGE_PHONE_KEY, a key kept outside
-- the database; the number itself is never stored. NULL: no number known. It lives on the
-- puppet's mapping row, so it goes with the bridge account (ON DELETE CASCADE).
--
-- phone_book_read_at marks the one-time read of the account's contact list that fills the
-- numbers of people met before this column existed; NULL until it ran.
--
-- Expand-only: new nullable columns; the previous binary neither reads nor writes them.

-- +goose Up

SET LOCAL lock_timeout = '5s';

ALTER TABLE external_users
	ADD COLUMN phone_hmac bytea CHECK (phone_hmac IS NULL OR octet_length(phone_hmac) = 32);

ALTER TABLE external_accounts
	ADD COLUMN phone_book_read_at timestamptz;

-- +goose Down

SET LOCAL lock_timeout = '5s';

ALTER TABLE external_users
	DROP COLUMN phone_hmac;

ALTER TABLE external_accounts
	DROP COLUMN phone_book_read_at;
