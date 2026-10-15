-- Message search (release R4) on Postgres: every message carries its vifold
-- search tokens (spec/vi-fold: the tokens of its text, caption and file name)
-- as a tsvector built from the tokens themselves (array_to_tsvector, no text
-- search parser, so the lexemes are exactly vifold's tokens), its media kind
-- and whether it holds a link. They are written in the transaction that
-- posts, edits or recalls the message. A GIN index serves the queries: every
-- query token is a lexeme, the last one a prefix ('tok':*).
-- pg_trgm would have served substring search, but PostgreSQL contrib is not
-- installed on the production server, and a word-prefix match is what both
-- clients' FTS5 already do.
-- User names get a Vietnamese fold so SearchUsers ignores accents.
-- Expand-only: new nullable columns, a function and an index, so the previous
-- binary keeps working on the migrated schema. Rows it writes keep a NULL
-- search_tsv and are indexed by the backfill that runs after every migration
-- (store.Migrate), as are the rows that exist now.

-- +goose Up

-- search_tsv: the lexemes, empty when nothing is searchable (service
-- messages, recalled messages, secret chats); NULL until indexed.
-- media_kind: app.v1.MediaKind of the attached file, 0 when none.
-- has_link: a URL or text link in the text, or a link preview.
ALTER TABLE messages
	ADD COLUMN search_tsv tsvector,
	ADD COLUMN media_kind smallint NOT NULL DEFAULT 0,
	ADD COLUMN has_link boolean NOT NULL DEFAULT false;

CREATE INDEX messages_search_idx ON messages USING gin (search_tsv);

-- Vietnamese fold of a display name for SearchUsers: the accented letters
-- (precomposed, either case) to their base letter, then lower case. Combining
-- marks of decomposed input are dropped first. Equals vifold.Fold for
-- Vietnamese names.
-- +goose StatementBegin
CREATE FUNCTION chat_fold_name(name text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
	SELECT lower(translate(regexp_replace(name, '[̀-ͯ]', '', 'g'),
		'ÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐàáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ',
		'AAAAAAAAAAAAAAAAAEEEEEEEEEEEIIIIIOOOOOOOOOOOOOOOOOUUUUUUUUUUUYYYYYDaaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd'))
$$;
-- +goose StatementEnd

-- +goose Down

DROP FUNCTION chat_fold_name(text);
DROP INDEX messages_search_idx;
ALTER TABLE messages DROP COLUMN has_link, DROP COLUMN media_kind, DROP COLUMN search_tsv;
