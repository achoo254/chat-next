// Schema version 1 of the Observatory database. Frozen once released: a
// later version adds a migration (migrate.ts) and never edits these
// statements. Times are Unix milliseconds; flags are 0/1. Paths are stored
// with the home folder written as `~`, text already redacted and cut short
// (the ingest does both before a row reaches the store).
//
// Rows of one session arrive from several sources in any order (hook
// callbacks, the hook spool, OpenTelemetry), so child rows do not reference
// `sessions` with a foreign key: a tool call may be stored before its
// session. Every event table has a key that tells a duplicate (the same
// event from a second source, or read again after a crash): tool_use_id,
// (session_id, agent_id), dedupe_key, prompt_id upsert on it;
// instructions_loaded and git_ops keep the first copy.
//
// The rows that can hold content (prompts.excerpt, tool_calls.content) carry
// the project of the event that wrote it (`project_key`): a session may move
// between repositories, and a project's content setting covers exactly the
// content written in it. A row without a project falls back on its
// session's (write-ops.ts, ObservatoryStore.clearContent).
//
// Detail tables are kept 90 days, then rolled into `daily_rollups` (kept for
// good) and deleted (retention.ts); each has an index on its time column for
// that, and on session_id for a session's timeline.
export const SCHEMA_V1: readonly string[] = [
  `CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY NOT NULL,
    previous_session_id TEXT,
    previous_session_inferred INTEGER CHECK (previous_session_inferred IN (0, 1)),
    project_key TEXT,
    cwd TEXT,
    source TEXT NOT NULL CHECK (source IN ('sdk', 'terminal', 'cli')),
    internal_label TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    main_model TEXT
  )`,
  `CREATE INDEX sessions_started_at ON sessions (started_at)`,
  `CREATE INDEX sessions_previous ON sessions (previous_session_id)`,

  `CREATE TABLE prompts (
    prompt_id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    length INTEGER,
    excerpt TEXT,
    project_key TEXT
  )`,
  `CREATE INDEX prompts_session ON prompts (session_id, at)`,
  `CREATE INDEX prompts_at ON prompts (at)`,

  `CREATE TABLE tool_calls (
    tool_use_id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL,
    prompt_id TEXT,
    agent_id TEXT,
    at INTEGER NOT NULL,
    tool_name TEXT,
    office_room TEXT,
    mcp_server TEXT,
    target TEXT,
    duration_ms INTEGER,
    input_bytes INTEGER,
    output_bytes INTEGER,
    success INTEGER CHECK (success IN (0, 1)),
    error TEXT,
    content TEXT,
    project_key TEXT
  )`,
  `CREATE INDEX tool_calls_session ON tool_calls (session_id, at)`,
  `CREATE INDEX tool_calls_at ON tool_calls (at)`,

  `CREATE TABLE subagents (
    session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    prompt_id TEXT,
    agent_type TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    model TEXT,
    total_tokens INTEGER,
    tool_count INTEGER,
    PRIMARY KEY (session_id, agent_id)
  )`,
  `CREATE INDEX subagents_started_at ON subagents (started_at)`,

  `CREATE TABLE api_requests (
    dedupe_key TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL,
    prompt_id TEXT,
    agent_id TEXT,
    at INTEGER NOT NULL,
    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_5m_tokens INTEGER,
    cache_write_1h_tokens INTEGER,
    cost_usd REAL,
    duration_ms INTEGER,
    ttft_ms INTEGER,
    query_source TEXT
  )`,
  `CREATE INDEX api_requests_session ON api_requests (session_id, at)`,
  `CREATE INDEX api_requests_at ON api_requests (at)`,

  `CREATE TABLE instructions_loaded (
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    at INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    memory_type TEXT,
    load_reason TEXT NOT NULL,
    PRIMARY KEY (session_id, file_path, load_reason, seq)
  )`,
  `CREATE INDEX instructions_loaded_session ON instructions_loaded (session_id, at)`,
  `CREATE INDEX instructions_loaded_at ON instructions_loaded (at)`,

  `CREATE TABLE git_ops (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    prompt_id TEXT,
    at INTEGER NOT NULL,
    sha TEXT,
    branch TEXT,
    kind TEXT NOT NULL
  )`,
  `CREATE INDEX git_ops_session ON git_ops (session_id, at)`,
  // A duplicate is the same operation (kind) on the same commit in a session
  // (a commit then a push of one sha are two rows); an operation without a
  // sha (a failed commit, a checkout) is the same kind at the same time and
  // prompt.
  `CREATE UNIQUE INDEX git_ops_sha ON git_ops (session_id, sha, kind) WHERE sha IS NOT NULL`,
  `CREATE UNIQUE INDEX git_ops_no_sha ON git_ops (session_id, COALESCE(prompt_id, ''), at, kind) WHERE sha IS NULL`,
  `CREATE INDEX git_ops_at ON git_ops (at)`,

  `CREATE TABLE content_settings (
    project_key TEXT PRIMARY KEY NOT NULL,
    store_content INTEGER NOT NULL CHECK (store_content IN (0, 1)),
    updated_at INTEGER NOT NULL
  )`,

  // One row per day, project and model ('' when unknown or when the counted
  // rows have no model: prompts, tool calls, git operations). Only days
  // already rolled up (older than the 90 days of detail) are here; recent
  // days are in the detail tables. Sessions with an internal label (the
  // Advisor's) are never counted.
  `CREATE TABLE daily_rollups (
    day TEXT NOT NULL,
    project_key TEXT NOT NULL,
    model TEXT NOT NULL,
    sessions INTEGER NOT NULL DEFAULT 0,
    prompts INTEGER NOT NULL DEFAULT 0,
    tool_calls INTEGER NOT NULL DEFAULT 0,
    tool_failures INTEGER NOT NULL DEFAULT 0,
    subagents INTEGER NOT NULL DEFAULT 0,
    api_requests INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    git_ops INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, project_key, model)
  )`,
];

/** Every table of the schema, in the order an export lists them. */
export const OBSERVATORY_TABLES = [
  "sessions",
  "prompts",
  "tool_calls",
  "subagents",
  "api_requests",
  "instructions_loaded",
  "git_ops",
  "content_settings",
  "daily_rollups",
] as const;

export type ObservatoryTable = (typeof OBSERVATORY_TABLES)[number];
