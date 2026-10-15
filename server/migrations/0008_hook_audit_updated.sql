-- Incoming webhooks can be edited after creation (UpdateIncomingHook): the
-- audit log gets the action "updated".
-- Expand-only: the check only widens, so the previous binary keeps working.

-- +goose Up

ALTER TABLE hook_audit DROP CONSTRAINT hook_audit_action_check;
ALTER TABLE hook_audit ADD CONSTRAINT hook_audit_action_check CHECK (action IN ('created', 'secret_rotated',
	'previous_secret_revoked', 'disabled', 'enabled', 'auto_disabled', 'taken_over', 'deleted', 'updated'));

-- +goose Down

-- The log is append-only, so rows written as "updated" stay; the narrower
-- check applies to new rows only.
ALTER TABLE hook_audit DROP CONSTRAINT hook_audit_action_check;
ALTER TABLE hook_audit ADD CONSTRAINT hook_audit_action_check CHECK (action IN ('created', 'secret_rotated',
	'previous_secret_revoked', 'disabled', 'enabled', 'auto_disabled', 'taken_over', 'deleted')) NOT VALID;
