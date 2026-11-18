-- Chat Bridge: removing a synced chat used to leave the keys of its messages in
-- external_messages. Syncing the same conversation again then found every message
-- "already imported" and imported none. The code now deletes the keys with the chat;
-- this removes the ones left by earlier removals: keys whose chat is no longer the one
-- the conversation is linked to.
--
-- The deploy backs the database up before it migrates. Keys of a live link are kept.

-- +goose Up

SET LOCAL lock_timeout = '5s';

DELETE FROM external_messages em
WHERE NOT EXISTS (
	SELECT 1 FROM external_chats x
	WHERE x.account_id = em.account_id AND x.external_chat_id = em.external_chat_id AND x.chat_id = em.chat_id
);

-- +goose Down

SELECT 1;
