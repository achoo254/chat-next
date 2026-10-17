-- Group and channel photos: a chat's current photo, a stored file of kind
-- photo. Expand-only: a nullable column the previous binary ignores. Files
-- that are a chat's photo are kept by the file collector.

-- +goose Up

SET LOCAL lock_timeout = '5s';

ALTER TABLE chats ADD COLUMN photo_file_id bigint REFERENCES files (id);

-- +goose Down

ALTER TABLE chats DROP COLUMN photo_file_id;
