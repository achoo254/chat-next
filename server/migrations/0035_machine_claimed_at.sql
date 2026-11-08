-- My machines (ADR 0013) join by account: tunelo registers a machine with
-- an IdP access token of its owner instead of an install code. claimed_at
-- is when the machine was first tied to that token's account (at
-- registration, or by ClaimMachine for a machine registered with an install
-- code). Once set, the server checks that the machine's tunnel is the one
-- Tunelo holds for its owner. The owner's IdP subject is users.idp_sub,
-- reached through machines.user_id: no copy is kept here.
--
-- A token of an account that never opened the chat creates its user at
-- registration, with a placeholder username and name and profile_pending
-- set: such a user is not found by username or search, and the first web
-- sign-in fills in the profile from the IdP and clears the flag.
--
-- Expand-only: a nullable column and a column with a constant default (no
-- table rewrite); the previous binary ignores both.

-- +goose Up

SET LOCAL lock_timeout = '5s';

ALTER TABLE machines ADD COLUMN claimed_at timestamptz;
ALTER TABLE users ADD COLUMN profile_pending boolean NOT NULL DEFAULT false;

-- +goose Down

SET LOCAL lock_timeout = '5s';

ALTER TABLE users DROP COLUMN profile_pending;
ALTER TABLE machines DROP COLUMN claimed_at;
