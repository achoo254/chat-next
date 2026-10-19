-- Mini Apps: a bot's main Mini App is an https URL on its developer's own
-- domain (ADR 0010), set in the Developer Console. Expand-only: a defaulted
-- column the previous binary ignores.

-- +goose Up

SET LOCAL lock_timeout = '5s';

-- The bot's main Mini App; '' for none. Validated when set (https, not
-- under the app's or a tenant's domain, no credentials, no IP host).
ALTER TABLE bots ADD COLUMN mini_app_url text NOT NULL DEFAULT '';

-- +goose Down

SET LOCAL lock_timeout = '5s';

ALTER TABLE bots DROP COLUMN mini_app_url;
