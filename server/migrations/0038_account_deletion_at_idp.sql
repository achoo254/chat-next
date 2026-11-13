-- Accounts are deleted only at the IdP, which tells the chat to erase them
-- at once (ADR 0016; auth-next ADR 0018). The chat's own deletion, its
-- 30-day grace period and the auto-delete setting are gone.
--
-- deletion_requested_at now marks a queued erasure; deletion_reason 'idp'
-- names the IdP's event. Accounts still in the old grace period ('user',
-- 'inactive') are erased by the privacy job on the first start of this
-- release. The auto-delete setting is switched off and its index dropped;
-- the column stays for now.
-- Expand-only: a relaxed CHECK, a reset setting and a dropped index. The
-- previous binary keeps working: it reads auto_delete_months (all 0, so its
-- inactivity scan finds nothing) and shows an 'idp' reason as unspecified.

-- +goose Up

SET LOCAL lock_timeout = '5s';

ALTER TABLE users DROP CONSTRAINT users_deletion_reason_check;
ALTER TABLE users ADD CONSTRAINT users_deletion_reason_check CHECK (deletion_reason IN ('user', 'inactive', 'idp'));

UPDATE users SET auto_delete_months = 0 WHERE auto_delete_months <> 0;
DROP INDEX users_auto_delete_idx;

-- +goose Down

SET LOCAL lock_timeout = '5s';

CREATE INDEX users_auto_delete_idx ON users (tenant_id)
	WHERE auto_delete_months > 0 AND deleted_at IS NULL AND deletion_requested_at IS NULL;
-- A queued IdP erasure becomes a user's request, which the previous
-- binary erases after its grace period.
UPDATE users SET deletion_reason = 'user' WHERE deletion_reason = 'idp';
ALTER TABLE users DROP CONSTRAINT users_deletion_reason_check;
ALTER TABLE users ADD CONSTRAINT users_deletion_reason_check CHECK (deletion_reason IN ('user', 'inactive'));
