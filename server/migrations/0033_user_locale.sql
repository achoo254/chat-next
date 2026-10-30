-- The language a user's app shows (UsersService.SetLocale, sent by the web
-- app at every start and when the user changes it): the assistant bot
-- writes to the user in it. Users who never sent theirs keep 'vi', the
-- language the assistant spoke before.
--
-- Expand-only: a column with a constant default (no table rewrite) the
-- previous binary ignores.

-- +goose Up

SET LOCAL lock_timeout = '5s';

ALTER TABLE users ADD COLUMN locale text NOT NULL DEFAULT 'vi' CHECK (locale IN ('vi', 'en', 'zh-CN'));

-- +goose Down

SET LOCAL lock_timeout = '5s';

ALTER TABLE users DROP COLUMN locale;
