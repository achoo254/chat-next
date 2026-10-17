-- Operations alerts of the server's own watchdog (package watch): the
-- incoming hook of the tenant's "Vận hành chat" group the alerts go to, and
-- the alerts firing now, so a restart still resolves them. Expand-only: new
-- tables the previous binary ignores.

-- +goose Up

SET LOCAL lock_timeout = '5s';

CREATE TABLE ops_alert_hooks (
	tenant_id text PRIMARY KEY REFERENCES tenants (id),
	hook_id text NOT NULL
);

CREATE TABLE ops_alerts (
	tenant_id text NOT NULL REFERENCES tenants (id),
	-- Stable name of the problem (memory_low, tenant_down:inetdev, ...).
	key text NOT NULL,
	-- What the firing message said, repeated when it resolves.
	name text NOT NULL,
	summary text NOT NULL,
	started_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (tenant_id, key)
);

-- +goose Down

DROP TABLE ops_alerts;
DROP TABLE ops_alert_hooks;
