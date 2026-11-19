-- Chat Bridge: the photo of a synced group is kept in step with the other app. photo_id
-- is the other app's id of the photo Chat last took or sent (empty for none), so a photo
-- is copied only when it changes.
--
-- Expand-only: a new column with a default; the previous binary neither reads nor writes it.

-- +goose Up

SET LOCAL lock_timeout = '5s';

ALTER TABLE external_chats ADD COLUMN photo_id text;

-- +goose Down

SET LOCAL lock_timeout = '5s';

ALTER TABLE external_chats DROP COLUMN photo_id;
