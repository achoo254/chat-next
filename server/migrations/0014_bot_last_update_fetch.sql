-- When a bot last asked for updates (Bot API long poll GET /bot/v1/updates),
-- so its owner can see that no program is running it. Written at most every
-- 30 seconds per bot. Expand-only: the previous binary ignores the column.

-- +goose Up

ALTER TABLE bots ADD COLUMN last_update_fetch_at timestamptz;

-- +goose Down

ALTER TABLE bots DROP COLUMN last_update_fetch_at;
