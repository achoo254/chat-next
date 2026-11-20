-- Chat Bridge: peer_ref is the other app's opaque handle to find a conversation again once
-- it has dropped out of the account's list (for Telegram, a channel's access hash). With
-- it Chat asks whether the conversation was deleted or the account removed, and keeps the
-- copy read-only, instead of guessing from the list alone.
--
-- Expand-only: a new nullable column; the previous binary neither reads nor writes it.

-- +goose Up

SET LOCAL lock_timeout = '5s';

ALTER TABLE external_chats ADD COLUMN peer_ref text;

-- +goose Down

SET LOCAL lock_timeout = '5s';

ALTER TABLE external_chats DROP COLUMN peer_ref;
