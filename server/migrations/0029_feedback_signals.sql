-- User feedback signals for the operators: errors the web app caught,
-- counted per kind and day (FeedbackService.ReportClientError); the last
-- day the daily digest was posted into the "Vận hành chat" group, so a
-- restart never posts it twice; and indexes by date for the digest's
-- counts.
--
-- Feedback sent from Settings › Góp ý (FeedbackService.SendFeedback) has
-- no message in the assistant's chat: it is stored with chat_id 0 and
-- seq = -id, which keeps feedback_message_key unique and every column the
-- previous binary reads valid.
--
-- Expand-only: new tables and indexes the previous binary ignores.

-- +goose Up

SET LOCAL lock_timeout = '5s';

CREATE TABLE client_errors (
	tenant_id text NOT NULL REFERENCES tenants (id),
	-- Day in Asia/Saigon.
	day date NOT NULL,
	-- Hash of kind, message and location (hex).
	fingerprint text NOT NULL,
	kind text NOT NULL,
	-- Scrubbed: no secrets, email addresses, phone numbers or long digits.
	message text NOT NULL,
	location text NOT NULL DEFAULT '',
	-- Newest release and route the error was seen on.
	release text NOT NULL DEFAULT '',
	route text NOT NULL DEFAULT '',
	count integer NOT NULL DEFAULT 1,
	first_seen timestamptz NOT NULL DEFAULT now(),
	last_seen timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (tenant_id, day, fingerprint)
);

CREATE TABLE ops_digests (
	tenant_id text PRIMARY KEY REFERENCES tenants (id),
	-- The day (Asia/Saigon) the last digest covered.
	last_day date NOT NULL,
	posted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX users_tenant_created_idx ON users (tenant_id, created_at);
CREATE INDEX feedback_tenant_created_idx ON feedback (tenant_id, created_at);
CREATE INDEX reports_tenant_created_idx ON reports (tenant_id, created_at);

-- +goose Down

SET LOCAL lock_timeout = '5s';

DROP INDEX reports_tenant_created_idx;
DROP INDEX feedback_tenant_created_idx;
DROP INDEX users_tenant_created_idx;
DROP TABLE ops_digests;
DROP TABLE client_errors;
