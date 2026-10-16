-- Who queued a bulk send: 0 for a bot's own (Bot API), the operator's user
-- id for an announcement of the tenant's assistant bot. Expand-only.

-- +goose Up

SET LOCAL lock_timeout = '5s';

ALTER TABLE bot_bulk_jobs ADD COLUMN created_by bigint NOT NULL DEFAULT 0;

-- +goose Down

ALTER TABLE bot_bulk_jobs DROP COLUMN created_by;
