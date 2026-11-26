-- The tag a member carries in the group, shown beside their name in the member list and on
-- their messages: Telegram's custom title of an admin or member tag ("BJ", "Nháy"). Written
-- by the bridge from the other app; '' when the member has none.
--
-- Expand-only: a column with a default the previous binary neither reads nor writes.

-- +goose Up

SET LOCAL lock_timeout = '5s';

ALTER TABLE chat_members ADD COLUMN rank text NOT NULL DEFAULT '';

-- +goose Down

SET LOCAL lock_timeout = '5s';

ALTER TABLE chat_members DROP COLUMN rank;
