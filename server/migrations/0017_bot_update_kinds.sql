-- Bot update kinds of R5 slice B2: member_changed (the bot's own
-- membership) and reaction (reactions on the bot's messages, opt-in through
-- allowed_updates). allowed_updates now also applies to a bot that polls
-- (set with getUpdates?allowed_updates=...); the column already exists.
-- Expand-only: the check only accepts more kinds; the previous binary
-- returns stored rows of any kind as they are.

-- +goose Up

SET LOCAL lock_timeout = '5s';

ALTER TABLE bot_updates DROP CONSTRAINT bot_updates_kind_check;
ALTER TABLE bot_updates ADD CONSTRAINT bot_updates_kind_check
	CHECK (kind IN ('message', 'message_edited', 'callback', 'channel_post', 'member_changed', 'reaction'));

-- +goose Down

SET LOCAL lock_timeout = '5s';

DELETE FROM bot_updates WHERE kind IN ('member_changed', 'reaction');
ALTER TABLE bot_updates DROP CONSTRAINT bot_updates_kind_check;
ALTER TABLE bot_updates ADD CONSTRAINT bot_updates_kind_check
	CHECK (kind IN ('message', 'message_edited', 'callback', 'channel_post'));
UPDATE bots SET allowed_updates = array_remove(array_remove(allowed_updates, 'member_changed'), 'reaction');
