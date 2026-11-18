-- Chat Bridge: pinning a message or a topic in Chat reaches the other app through
-- the outbox. A pin row says the state wanted (pinned) and is replaced by the next
-- change of the same message, so only the last state goes out. For a topic row
-- `seq` holds the id of the topic in the chat (a topic has no message number).

-- +goose Up

SET LOCAL lock_timeout = '5s';

ALTER TABLE external_outbox DROP CONSTRAINT external_outbox_op_check;
ALTER TABLE external_outbox ADD CONSTRAINT external_outbox_op_check
	CHECK (op IN ('send', 'edit', 'delete', 'pin_message', 'pin_topic'));
ALTER TABLE external_outbox ADD COLUMN pinned boolean NOT NULL DEFAULT true;

-- +goose Down

DELETE FROM external_outbox WHERE op IN ('pin_message', 'pin_topic');
ALTER TABLE external_outbox DROP COLUMN pinned;
ALTER TABLE external_outbox DROP CONSTRAINT external_outbox_op_check;
ALTER TABLE external_outbox ADD CONSTRAINT external_outbox_op_check CHECK (op IN ('send', 'edit', 'delete'));
