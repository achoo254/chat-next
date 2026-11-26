-- What a bot of another app (a Telegram bot) says about itself, kept on the puppet that stands
-- for it: the description shown in an empty chat, the short text, the command menu and the
-- button that opens the bot in the other app. Read by the bridge from the other app now and then
-- and served to the owner of the account that met the bot; the picture shown above the
-- description is copied to the owner's media (bot_photo_file_id) so it does not depend on the
-- other app's links, which expire.
--
-- bot_info is JSON written by the bridge ({description, about, commands, open_kind, photo_id});
-- bot_info_at is when it was read (NULL: never).
--
-- Expand-only: nullable columns the previous binary neither reads nor writes.

-- +goose Up

SET LOCAL lock_timeout = '5s';

ALTER TABLE external_users
	ADD COLUMN bot_info jsonb,
	ADD COLUMN bot_info_at timestamptz,
	ADD COLUMN bot_photo_file_id bigint REFERENCES files (id) ON DELETE SET NULL;

-- +goose Down

SET LOCAL lock_timeout = '5s';

ALTER TABLE external_users
	DROP COLUMN bot_photo_file_id,
	DROP COLUMN bot_info_at,
	DROP COLUMN bot_info;
