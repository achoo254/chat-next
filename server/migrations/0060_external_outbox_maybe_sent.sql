-- Chat Bridge: maybe_sent marks a send whose earlier call to the other app may have
-- created the message: it went 'unknown' (in flight when the run stopped, in flight too
-- long, or failed without saying nothing went out). The mark stays when the owner retries
-- the row, so the engine can tell the adapter that this call repeats one that may have
-- gone out: an adapter that cannot recognise a repeated RandomID on its own
-- (bridge.RetryUnsafe, Zalo) then looks for the earlier copy before sending, and sends
-- anything else at once.
--
-- Rows already 'unknown' (or in flight) are marked here: they are exactly such sends.
--
-- Expand-only: a new column with a default; the previous binary neither reads nor writes it.
-- Version 0059 is not used: it was a step that never shipped.

-- +goose Up

SET LOCAL lock_timeout = '5s';

ALTER TABLE external_outbox ADD COLUMN maybe_sent boolean NOT NULL DEFAULT false;
UPDATE external_outbox SET maybe_sent = true WHERE op = 'send' AND status IN ('unknown', 'sending');

-- +goose Down

SET LOCAL lock_timeout = '5s';

ALTER TABLE external_outbox DROP COLUMN maybe_sent;
