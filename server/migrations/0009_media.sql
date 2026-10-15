-- Media (release R3): uploaded files, resumable upload sessions, the index of
-- which messages carry which file (download access and revocation), the
-- processing queue of the media worker, and og:image photos of link
-- previews.
-- Expand-only: new tables and one new column, so the previous binary keeps
-- working on the migrated schema.

-- +goose Up

-- A stored file. id is internal; public_id is the opaque file_id clients
-- see (ADR 0001). The object key holds a uuid that never leaves the server.
-- owner_id 0 is the server itself (link preview photos).
CREATE TABLE files (
	id bigserial PRIMARY KEY,
	public_id text NOT NULL UNIQUE CHECK (public_id ~ '^[A-Za-z0-9_-]{22}$'),
	tenant_id text NOT NULL REFERENCES tenants (id),
	owner_id bigint NOT NULL CHECK (owner_id >= 0),
	kind text NOT NULL CHECK (kind IN ('photo', 'video', 'audio', 'voice', 'document')),
	-- Detected from the content (magic bytes), never the client's claim.
	mime_type text NOT NULL,
	size bigint NOT NULL CHECK (size > 0),
	file_name text NOT NULL DEFAULT '',
	-- Hex SHA-256 of the stored bytes when the server read them all (photos,
	-- stripped images); otherwise the uploader's declared hash.
	file_hash text NOT NULL CHECK (file_hash ~ '^[0-9a-f]{64}$'),
	-- Declared hash of the uploaded bytes: the owner's dedupe key.
	source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
	width integer NOT NULL DEFAULT 0,
	height integer NOT NULL DEFAULT 0,
	duration_ms integer NOT NULL DEFAULT 0,
	inline_thumb bytea,
	waveform bytea,
	object_key text NOT NULL UNIQUE,
	-- Renditions: [{"t": 1..3, "w", "h", "s": bytes, "k": object key}].
	sizes jsonb NOT NULL DEFAULT '[]',
	created_at timestamptz NOT NULL DEFAULT now()
);
-- Dedupe within one owner (never across owners or tenants) and quota sums.
CREATE INDEX files_owner_idx ON files (tenant_id, owner_id, source_hash);
CREATE INDEX files_created_idx ON files (created_at);

-- A resumable multipart upload. id is the opaque upload_id; the object is
-- written to a random staging key, so presigned URLs never show the file's
-- key. Kept 24 hours; file_id is set once completed, so a retried
-- CompleteUpload answers with the same file.
CREATE TABLE uploads (
	id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{22}$'),
	tenant_id text NOT NULL REFERENCES tenants (id),
	owner_id bigint NOT NULL CHECK (owner_id > 0),
	s3_upload_id text NOT NULL,
	staging_key text NOT NULL UNIQUE,
	kind text NOT NULL CHECK (kind IN ('photo', 'video', 'audio', 'voice', 'document')),
	file_name text NOT NULL DEFAULT '',
	mime_type text NOT NULL DEFAULT '',
	size bigint NOT NULL CHECK (size > 0),
	part_size bigint NOT NULL CHECK (part_size > 0),
	file_hash text NOT NULL CHECK (file_hash ~ '^[0-9a-f]{64}$'),
	width integer NOT NULL DEFAULT 0,
	height integer NOT NULL DEFAULT 0,
	duration_ms integer NOT NULL DEFAULT 0,
	inline_thumb bytea,
	waveform bytea,
	-- A CompleteUpload holds this lease while it works outside any
	-- transaction; a crashed one is retried after it expires.
	completing_until timestamptz,
	file_id bigint REFERENCES files (id) ON DELETE SET NULL,
	completed_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now(),
	expires_at timestamptz NOT NULL
);
CREATE INDEX uploads_owner_idx ON uploads (tenant_id, owner_id) WHERE completed_at IS NULL;
CREATE INDEX uploads_expires_idx ON uploads (expires_at);

-- Which message carries which file: its media ('media') or its link
-- preview photo ('preview'). A download URL works only while its row
-- exists, so deleting a message for everyone revokes access at once; a
-- file without rows is collected after a grace period.
CREATE TABLE message_files (
	chat_id bigint NOT NULL,
	seq bigint NOT NULL,
	file_id bigint NOT NULL REFERENCES files (id),
	role text NOT NULL CHECK (role IN ('media', 'preview')),
	PRIMARY KEY (chat_id, seq, file_id)
);
CREATE INDEX message_files_file_idx ON message_files (file_id);

-- Work for the media worker (video posters, durations, voice waveforms);
-- only queued when ffmpeg is configured.
CREATE TABLE media_jobs (
	file_id bigint PRIMARY KEY REFERENCES files (id) ON DELETE CASCADE,
	attempts integer NOT NULL DEFAULT 0,
	run_after timestamptz NOT NULL DEFAULT now(),
	last_error text NOT NULL DEFAULT ''
);
CREATE INDEX media_jobs_run_idx ON media_jobs (run_after);

-- og:image of a previewed page, stored per tenant as a server-owned photo.
-- file_id NULL: the image could not be fetched (retried after an hour).
CREATE TABLE link_preview_photos (
	tenant_id text NOT NULL REFERENCES tenants (id),
	image_url text NOT NULL,
	file_id bigint REFERENCES files (id) ON DELETE SET NULL,
	fetched_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (tenant_id, image_url)
);
CREATE INDEX link_preview_photos_fetched_idx ON link_preview_photos (fetched_at);
CREATE INDEX link_preview_photos_file_idx ON link_preview_photos (file_id);

-- The page's og:image URL (absolute, http/https), '' when none.
ALTER TABLE link_previews ADD COLUMN image_url text NOT NULL DEFAULT '';

-- +goose Down

ALTER TABLE link_previews DROP COLUMN image_url;
DROP TABLE link_preview_photos;
DROP TABLE media_jobs;
DROP TABLE message_files;
DROP TABLE uploads;
DROP TABLE files;
