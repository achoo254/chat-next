-- Push notifications in Simplified Chinese: a subscription's locale may
-- also be 'zh-CN', the third language of the web app.
--
-- Expand-only: the check only accepts one more value; the previous binary
-- reads every stored locale and falls back to Vietnamese for one it has no
-- text for.

-- +goose Up

SET LOCAL lock_timeout = '5s';

ALTER TABLE push_subscriptions DROP CONSTRAINT push_subscriptions_locale_check;
ALTER TABLE push_subscriptions ADD CONSTRAINT push_subscriptions_locale_check
	CHECK (locale IN ('vi', 'en', 'zh-CN'));

-- +goose Down

SET LOCAL lock_timeout = '5s';

UPDATE push_subscriptions SET locale = 'en' WHERE locale = 'zh-CN';
ALTER TABLE push_subscriptions DROP CONSTRAINT push_subscriptions_locale_check;
ALTER TABLE push_subscriptions ADD CONSTRAINT push_subscriptions_locale_check
	CHECK (locale IN ('vi', 'en'));
