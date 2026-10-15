-- Webhook delivery of bot updates (release R5, slice B1). A bot either polls
-- (GET /bot/v1/updates) or has a webhook: the api process POSTs each update
-- to bots.webhook_url, in order within one queue (a chat, or the presser
-- for callbacks) and in parallel across queues up to
-- webhook_max_connections. bot_updates stays the source of truth: an update
-- is pending while NOT acked AND dead_at IS NULL; a 2xx answer acks it.
-- Failed attempts back off; after 10 the update is dead-lettered (dead_at)
-- until it expires, and later updates of its queue go on.
-- Expand-only: the previous binary ignores the new columns and table, and
-- never writes channel_post rows.

-- +goose Up

SET LOCAL lock_timeout = '5s';

ALTER TABLE bots
	ADD COLUMN webhook_url text,
	-- The secret the bot chose, sealed with SESSION_KEY (sealbox purpose
	-- "bot-webhook-secret", bound to the bot id); sent back to the bot in a
	-- header and used as the HMAC key of each request.
	ADD COLUMN webhook_secret bytea,
	ADD COLUMN webhook_max_connections smallint NOT NULL DEFAULT 40
		CHECK (webhook_max_connections BETWEEN 1 AND 100),
	-- Update kinds stored for the bot while its webhook is set; empty means
	-- every kind. Applied when an update is cut, not to queued ones.
	ADD COLUMN allowed_updates text[] NOT NULL DEFAULT '{}',
	ADD COLUMN webhook_set_at timestamptz,
	ADD CONSTRAINT bots_webhook_complete CHECK ((webhook_url IS NULL) = (webhook_secret IS NULL));

ALTER TABLE bot_updates
	-- Delivery queue: the chat id for message updates, minus the presser's
	-- user id for callbacks (the two ranges never meet).
	ADD COLUMN queue_key bigint NOT NULL DEFAULT 0,
	ADD COLUMN attempts smallint NOT NULL DEFAULT 0,
	-- NULL: due now.
	ADD COLUMN next_attempt_at timestamptz,
	-- Machine-readable reason of the last failed attempt (http_502, timeout,
	-- tls, connect, dns, blocked_address, invalid_url, secret_unreadable).
	ADD COLUMN last_error text,
	ADD COLUMN last_error_at timestamptz,
	ADD COLUMN delivered_at timestamptz,
	ADD COLUMN dead_at timestamptz;

ALTER TABLE bot_updates DROP CONSTRAINT bot_updates_kind_check;
ALTER TABLE bot_updates ADD CONSTRAINT bot_updates_kind_check
	CHECK (kind IN ('message', 'message_edited', 'callback', 'channel_post'));

-- Heads of the pending queues of a bot, and its dead letters.
CREATE INDEX bot_updates_pending_idx ON bot_updates (bot_id, queue_key, update_id) WHERE NOT acked AND dead_at IS NULL;
CREATE INDEX bot_updates_dead_idx ON bot_updates (bot_id, dead_at) WHERE dead_at IS NOT NULL AND NOT acked;

-- Delivery counters per bot and hour, for the Developer Console (last 24
-- hours shown, two days kept), with the last success and the last failure
-- of the webhook (the newest row of a bot has the current ones).
CREATE TABLE bot_delivery_counters (
	bot_id bigint NOT NULL REFERENCES bots (user_id) ON DELETE CASCADE,
	hour timestamptz NOT NULL,
	-- Updates stored for the bot.
	received integer NOT NULL DEFAULT 0,
	-- Acknowledged by a 2xx of the webhook or by a long poll.
	delivered integer NOT NULL DEFAULT 0,
	-- Failed webhook attempts.
	failed integer NOT NULL DEFAULT 0,
	dead_lettered integer NOT NULL DEFAULT 0,
	last_delivered_at timestamptz,
	last_delivery_ms integer,
	last_error text,
	last_error_at timestamptz,
	PRIMARY KEY (bot_id, hour)
);
CREATE INDEX bot_delivery_counters_hour_idx ON bot_delivery_counters (hour);

-- +goose Down

DROP TABLE bot_delivery_counters;
DROP INDEX bot_updates_dead_idx;
DROP INDEX bot_updates_pending_idx;
DELETE FROM bot_updates WHERE kind = 'channel_post';
ALTER TABLE bot_updates DROP CONSTRAINT bot_updates_kind_check;
ALTER TABLE bot_updates ADD CONSTRAINT bot_updates_kind_check CHECK (kind IN ('message', 'message_edited', 'callback'));
ALTER TABLE bot_updates
	DROP COLUMN dead_at,
	DROP COLUMN delivered_at,
	DROP COLUMN last_error_at,
	DROP COLUMN last_error,
	DROP COLUMN next_attempt_at,
	DROP COLUMN attempts,
	DROP COLUMN queue_key;
ALTER TABLE bots
	DROP CONSTRAINT bots_webhook_complete,
	DROP COLUMN webhook_set_at,
	DROP COLUMN allowed_updates,
	DROP COLUMN webhook_max_connections,
	DROP COLUMN webhook_secret,
	DROP COLUMN webhook_url;
