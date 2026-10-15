-- Substring message search: every message also carries its vifold search
-- text (spec/vi-fold: the tokens of its text, caption and file name joined by
-- single spaces) in search_text, with a pg_trgm GIN index, so a query word is
-- found inside a word ("uan" finds "tuần"). It is written in the transaction
-- that posts, edits or recalls the message, like search_tsv.
-- pg_trgm ships with postgresql-contrib and is a trusted extension
-- (PostgreSQL 13+): a role with CREATE on the database, such as its owner,
-- creates it without being a superuser. Without contrib, or without that
-- privilege, this migration fails and changes nothing (see
-- docs/deployment-guide.md).
-- Expand-only: search_tsv stays (queries whose words are all shorter than
-- three characters match word starts through it, and the previous binary
-- reads it). The previous binary does not write search_text; rows it writes
-- keep a NULL search_text and are indexed by the backfill that runs after
-- every migration (store.Migrate), as are the rows that exist now.

-- +goose Up

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- search_text: NULL until indexed, '' when nothing is searchable (service
-- messages, recalled messages, secret chats).
ALTER TABLE messages ADD COLUMN search_text text;

CREATE INDEX messages_search_text_idx ON messages USING gin (search_text gin_trgm_ops);

-- +goose Down

-- The extension stays: it may predate this migration or serve other objects,
-- and Up creates it only when missing.
DROP INDEX messages_search_text_idx;
ALTER TABLE messages DROP COLUMN search_text;
