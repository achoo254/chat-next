-- Chat Bridge: the profile photo of a person of the other app becomes the photo of their
-- puppet user. photo_want is the id of the photo the other app last showed ('' for none),
-- NULL while the adapter never read it; photo_ref is the adapter's ref of its bytes;
-- photo_id is the id of the photo the puppet has (NULL before the first copy). A row whose
-- photo_want differs from photo_id is copied by the account's runner, a few per look.
--
-- Expand-only: new nullable columns; the previous binary neither reads nor writes them.

-- +goose Up

SET LOCAL lock_timeout = '5s';

ALTER TABLE external_users
	ADD COLUMN photo_want text,
	ADD COLUMN photo_ref text,
	ADD COLUMN photo_id text;

-- +goose Down

SET LOCAL lock_timeout = '5s';

ALTER TABLE external_users
	DROP COLUMN photo_want,
	DROP COLUMN photo_ref,
	DROP COLUMN photo_id;
