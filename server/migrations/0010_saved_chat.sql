-- "Cloud của tôi" (release R3b): every user has a private chat with
-- themselves, stored like any private chat with user_low = user_high.
-- Expand-only: the relaxed check accepts every row the old one did, so the
-- previous binary keeps working on the migrated schema.

-- +goose Up

ALTER TABLE private_chats DROP CONSTRAINT private_chats_check;
ALTER TABLE private_chats ADD CONSTRAINT private_chats_check CHECK (user_low <= user_high);

-- +goose Down

DELETE FROM chats WHERE id IN (SELECT chat_id FROM private_chats WHERE user_low = user_high);
ALTER TABLE private_chats DROP CONSTRAINT private_chats_check;
ALTER TABLE private_chats ADD CONSTRAINT private_chats_check CHECK (user_low < user_high);
