-- Accounts and chat sessions (ADR 0006), scoped by tenant from the first
-- migration (ADR 0010).

-- +goose Up

CREATE TABLE tenants (
	id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
	domain text NOT NULL UNIQUE,
	display_name text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now()
);

-- Per-shard local part of user ids (ids.MakeSharded): 1 .. 2^43-1.
CREATE SEQUENCE user_local_id_seq AS bigint MINVALUE 1 MAXVALUE 8796093022207;

CREATE TABLE users (
	-- ids.MakeSharded(shard, nextval('user_local_id_seq')); always < 2^53.
	id bigint PRIMARY KEY CHECK (id > 0 AND id < 9007199254740992),
	tenant_id text NOT NULL REFERENCES tenants (id),
	-- Stable IdP account id (acc_...); never changes with email or username.
	idp_sub text NOT NULL,
	-- Stored lowercase only, so a plain unique index is case-insensitive.
	username text NOT NULL CHECK (username ~ '^[a-z0-9_]{3,32}$'),
	name text NOT NULL,
	bio text NOT NULL DEFAULT '',
	-- Copied from the IdP; kept only while the IdP reports it verified.
	email text,
	email_verified boolean NOT NULL DEFAULT false,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT users_tenant_idp_sub_key UNIQUE (tenant_id, idp_sub),
	CONSTRAINT users_tenant_username_key UNIQUE (tenant_id, username),
	CONSTRAINT users_email_only_verified CHECK (email IS NULL OR email_verified)
);

CREATE TABLE user_sessions (
	id bigserial PRIMARY KEY,
	-- SHA-256 of the opaque session token; the token itself is never stored.
	token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
	tenant_id text NOT NULL REFERENCES tenants (id),
	user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	idp_sid text,
	idp_client_id text NOT NULL,
	-- AES-256-GCM sealed IdP tokens (sealbox); never sent to any client.
	refresh_token_enc bytea,
	id_token_enc bytea,
	idp_checked_at timestamptz NOT NULL DEFAULT now(),
	created_at timestamptz NOT NULL DEFAULT now(),
	last_seen_at timestamptz NOT NULL DEFAULT now(),
	user_agent text NOT NULL DEFAULT '',
	ip inet,
	revoked_at timestamptz
);

CREATE INDEX user_sessions_user_active_idx ON user_sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX user_sessions_sid_active_idx ON user_sessions (tenant_id, idp_sid)
	WHERE idp_sid IS NOT NULL AND revoked_at IS NULL;

-- Back-channel logout tokens already processed (replay protection).
CREATE TABLE oidc_logout_jti (
	jti text PRIMARY KEY,
	expires_at timestamptz NOT NULL
);

CREATE INDEX oidc_logout_jti_expires_idx ON oidc_logout_jti (expires_at);

-- +goose Down

DROP TABLE oidc_logout_jti;
DROP TABLE user_sessions;
DROP TABLE users;
DROP SEQUENCE user_local_id_seq;
DROP TABLE tenants;
