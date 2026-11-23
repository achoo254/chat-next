-- Chat Bridge: the per-account sending switch (0058) is gone. An app Chat can write to
-- syncs both ways as soon as its account is connected, Zalo like Telegram (ADR 0024).
--
-- No chat is raised here: the engine raises the read-only chats of a connected account
-- whose conversation the app lists, through the chat service, so the owner's open
-- sessions learn that the chat takes messages again (an UPDATE here would leave their
-- stored copy read-only, and the engine would then see nothing left to raise).
--
-- Contract-only: the binary of this release neither reads nor writes the column. A
-- release that still has the switch reads it; going back to one needs this Down first.
-- The deploy backs the database up before migrating (activate-release.sh).

-- +goose Up

SET LOCAL lock_timeout = '5s';

ALTER TABLE external_accounts DROP COLUMN send_enabled;

-- +goose Down

SET LOCAL lock_timeout = '5s';

ALTER TABLE external_accounts ADD COLUMN send_enabled boolean NOT NULL DEFAULT false;
