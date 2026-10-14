-- Lease of a running IdP grant check (ADR 0006). A check claims the session
-- by setting grant_lease_until with one UPDATE, calls the IdP outside any
-- transaction, and writes its outcome only while the lease is still its own,
-- so no row lock is held across the IdP call and a refresh token is never
-- sent twice. NULL: no check is running.

-- +goose Up

ALTER TABLE user_sessions ADD COLUMN grant_lease_until timestamptz;

-- +goose Down

ALTER TABLE user_sessions DROP COLUMN grant_lease_until;
