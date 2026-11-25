-- Finding a person by phone number. users.phone_hmac is HMAC-SHA256 of the E.164 number under
-- BRIDGE_PHONE_KEY (a key kept outside the database); the number itself is never stored. It is
-- set only from the number the person's own Telegram or Zalo account was verified with, never
-- from what a person types, so a number cannot be claimed by someone else. NULL: no number known.
--
-- find_by_phone is who may find the person by that exact number (1 everyone, 2 contacts, 3 nobody);
-- everyone by default, like the username, because the number is verified and has to be known whole.
--
-- Expand-only: new nullable column and a defaulted column; the previous binary neither reads nor
-- writes them.

-- +goose Up

SET LOCAL lock_timeout = '5s';

ALTER TABLE users
	ADD COLUMN phone_hmac bytea CHECK (phone_hmac IS NULL OR octet_length(phone_hmac) = 32);

CREATE INDEX users_phone_hmac_idx ON users (tenant_id, phone_hmac) WHERE phone_hmac IS NOT NULL;

ALTER TABLE privacy_settings
	ADD COLUMN find_by_phone smallint NOT NULL DEFAULT 1 CHECK (find_by_phone BETWEEN 1 AND 3);

-- +goose Down

SET LOCAL lock_timeout = '5s';

ALTER TABLE privacy_settings
	DROP COLUMN find_by_phone;

DROP INDEX users_phone_hmac_idx;

ALTER TABLE users
	DROP COLUMN phone_hmac;
