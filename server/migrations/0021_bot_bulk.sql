-- Bulk sends of bots (POST /bot/v1/messages:bulk): one message to many
-- users, each in the bot's private chat, only users who started the bot.
-- A job is sent in the background at the bot tier's bulk pace; the daily
-- caps count the recipients of a bot's jobs of the last 24 hours.
-- Expand-only: a new table the previous binary ignores.

-- +goose Up

SET LOCAL lock_timeout = '5s';

CREATE TABLE bot_bulk_jobs (
	id bigserial PRIMARY KEY,
	tenant_id text NOT NULL REFERENCES tenants (id),
	bot_id bigint NOT NULL REFERENCES bots (user_id) ON DELETE CASCADE,
	-- ids: user_ids (sorted, unique); all: every user with consent, by user id.
	audience text NOT NULL CHECK (audience IN ('ids', 'all')),
	user_ids bigint[] NOT NULL DEFAULT '{}',
	-- The message: text, and entities and keyboard as an app.v1.Message.
	text text NOT NULL,
	content bytea,
	no_link_preview boolean NOT NULL DEFAULT false,
	-- Messages per second of this job.
	pace int NOT NULL CHECK (pace > 0),
	state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'done', 'cancelled')),
	-- Why a job stopped early: cancelled by the bot, bot deleted or restricted.
	reason text NOT NULL DEFAULT '',
	total int NOT NULL,
	-- ids: the next index into user_ids; all: the last user id handled.
	progress bigint NOT NULL DEFAULT 0,
	sent int NOT NULL DEFAULT 0,
	skipped int NOT NULL DEFAULT 0,
	failed int NOT NULL DEFAULT 0,
	lease_until timestamptz,
	created_at timestamptz NOT NULL DEFAULT now(),
	finished_at timestamptz
);

-- The worker's next jobs, and a bot's jobs of the last day (daily cap).
CREATE INDEX bot_bulk_jobs_active_idx ON bot_bulk_jobs (tenant_id, id) WHERE state IN ('queued', 'running');
CREATE INDEX bot_bulk_jobs_bot_idx ON bot_bulk_jobs (bot_id, created_at);

-- +goose Down

DROP TABLE bot_bulk_jobs;
