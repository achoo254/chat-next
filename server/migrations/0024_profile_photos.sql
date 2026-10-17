-- Profile photos: a user's (for now a bot's, set in the Developer Console)
-- current photo, a stored file of kind photo. Expand-only: a nullable
-- column the previous binary ignores. Files that are someone's photo are
-- kept by the file collector.

-- +goose Up

SET LOCAL lock_timeout = '5s';

ALTER TABLE users ADD COLUMN photo_file_id bigint REFERENCES files (id);

-- +goose Down

ALTER TABLE users DROP COLUMN photo_file_id;
