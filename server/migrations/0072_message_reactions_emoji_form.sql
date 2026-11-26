-- Reactions are kept in the form Chat's picker writes: a heart from Telegram ("❤", U+2764)
-- and one picked in Chat ("❤️", with U+FE0F) are one reaction, drawn in colour. Rows stored
-- before (from the other app) get the variation selector after the code points that show as
-- text without it (feature.CanonicalEmoji). One user has one reaction per message, so no row
-- collides.
--
-- Data only, forward: the previous binary reads either form.

-- +goose Up

SET LOCAL lock_timeout = '5s';

UPDATE message_reactions
SET emoji = regexp_replace(emoji, '([☀☃♀♂✌✍❤🕊])(?!️)', '\1️', 'g')
WHERE emoji ~ '[☀☃♀♂✌✍❤🕊]' AND emoji <> regexp_replace(emoji, '([☀☃♀♂✌✍❤🕊])(?!️)', '\1️', 'g');

-- +goose Down

SELECT 1;
