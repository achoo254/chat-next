-- My machines (ADR 0013) join by account: tunelo registers a machine with
-- an IdP access token of its owner instead of an install code. claimed_at
-- is when the machine was first tied to that token's account (at
-- registration, or by ClaimMachine for a machine registered with an install
-- code). Once set, the server checks that the machine's tunnel is the one
-- Tunelo holds for its owner. The owner's IdP subject is users.idp_sub,
-- reached through machines.user_id: no copy is kept here.
--
-- Expand-only: one nullable column; the previous binary ignores it.

-- +goose Up

SET LOCAL lock_timeout = '5s';

ALTER TABLE machines ADD COLUMN claimed_at timestamptz;

-- +goose Down

SET LOCAL lock_timeout = '5s';

ALTER TABLE machines DROP COLUMN claimed_at;
