-- The profile picture the IdP reports (the OIDC `picture` claim of the
-- `profile` scope: a Google or GitHub avatar URL), shown on the account
-- menu of the user's own app when they did not upload a chat photo.
-- Refreshed at each sign-in and grant check, NULL when the IdP has none,
-- cleared when the account is erased. Never shown to other users.
--
-- Expand-only: a nullable column the previous binary ignores.

-- +goose Up

SET LOCAL lock_timeout = '5s';

ALTER TABLE users ADD COLUMN idp_picture text CHECK (char_length(idp_picture) <= 2048);

-- +goose Down

ALTER TABLE users DROP COLUMN idp_picture;
