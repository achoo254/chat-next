-- A puppet user stands for a contact of another app (ADR 0022). When that contact is a bot there
-- (a Telegram bot), external_users.is_bot says so, so Chat can show the chat under Bot and
-- offer the bot's profile. It is not users.is_bot: that flag means a bot of this system (a bots
-- row, consent, Bot API), which a puppet is not.
--
-- Written by the bridge each time it meets the contact, so rows that existed before the column
-- correct themselves at the next sync. Expand-only: a defaulted column the previous binary
-- neither reads nor writes.

-- +goose Up

SET LOCAL lock_timeout = '5s';

ALTER TABLE external_users
	ADD COLUMN is_bot boolean NOT NULL DEFAULT false;

-- +goose Down

SET LOCAL lock_timeout = '5s';

ALTER TABLE external_users
	DROP COLUMN is_bot;
