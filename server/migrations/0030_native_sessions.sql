-- Native app sessions (ADR 0006, ADR 0011): AuthService.ExchangeNativeCode
-- signs the iOS and Android apps in with the chat-mobile client and records
-- what the app said about itself. platform holds app.v1.ClientPlatform
-- (1 web, 2 iOS, 3 Android); a session with platform 2 or 3 authenticates
-- with the Authorization header instead of the cookie and has no 90 day
-- cap. device_name and app_version are what ListSessions shows for it; web
-- sessions keep deriving the device from user_agent.
--
-- Expand-only: new columns with defaults that the previous binary ignores
-- (every session it creates is a web session).

-- +goose Up

SET LOCAL lock_timeout = '5s';

ALTER TABLE user_sessions
	ADD COLUMN platform smallint NOT NULL DEFAULT 1 CHECK (platform IN (1, 2, 3)),
	ADD COLUMN device_name text NOT NULL DEFAULT '',
	ADD COLUMN app_version text NOT NULL DEFAULT '';

-- +goose Down

ALTER TABLE user_sessions
	DROP COLUMN app_version,
	DROP COLUMN device_name,
	DROP COLUMN platform;
