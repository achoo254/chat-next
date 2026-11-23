// Schema version 2 of the Observatory database: what the Live Map reads.
// Only adds (columns that may be NULL, tables, indexes), so the minimum
// reader stays 1 (migrate.ts): an agent of version 1 opens a version 2
// database as it is and writes only what it knows. Frozen once released,
// like schema-v1.ts.
//
// - `tool_calls` gains the call's Live Map station and its flags
//   (live-map/station-map.ts, the `estimated` bit when the station was
//   placed from the filtered target), the salted key of the file it touched
//   (privacy/target-key-salt.ts), and a Read's page (offset, limit).
// - `session_events`: the moments of a session that are not a tool call, a
//   prompt or an API call: permission asked, decided or denied, a hook
//   blocking a call, compaction, the turn's end or failure, notifications,
//   a change of model or permission mode, the counts of a todo list, an API
//   error, an MCP server connecting. Only a kind, a short label, a number and
//   a flag: never content (the label is a name the privacy filter already
//   kept: a tool, a model, a trigger). One row per event, keyed by a dedupe
//   key the ingest builds per kind, so an event read twice is stored once
//   (at its earliest time).
// - `bottlenecks`: one row per finding of a bottleneck rule, keyed by
//   (session_id, rule, subkey): opened, raised, closed in place.
//
// Rows of both tables are kept 90 days like the other detail tables
// (retention.ts), and counted into no daily total.
export const SCHEMA_V2: readonly string[] = [
  `ALTER TABLE tool_calls ADD COLUMN station TEXT`,
  `ALTER TABLE tool_calls ADD COLUMN station_flags INTEGER`,
  `ALTER TABLE tool_calls ADD COLUMN target_key TEXT`,
  `ALTER TABLE tool_calls ADD COLUMN read_offset INTEGER`,
  `ALTER TABLE tool_calls ADD COLUMN read_limit INTEGER`,
  // A tool's history (percentiles by tool) and the sessions of a project in time order.
  `CREATE INDEX tool_calls_tool ON tool_calls (tool_name, at)`,
  `CREATE INDEX sessions_project ON sessions (project_key, started_at)`,

  `CREATE TABLE session_events (
    dedupe_key TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    agent_id TEXT,
    tool_use_id TEXT,
    station TEXT,
    label TEXT,
    number REAL,
    flag INTEGER CHECK (flag IN (0, 1))
  )`,
  `CREATE INDEX session_events_session ON session_events (session_id, at)`,
  `CREATE INDEX session_events_at ON session_events (at)`,

  // `subkey` is '' for a rule without one, so the unique key holds (NULLs are all distinct in SQLite).
  `CREATE TABLE bottlenecks (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    rule TEXT NOT NULL,
    subkey TEXT NOT NULL,
    station TEXT,
    severity TEXT NOT NULL CHECK (severity IN ('warn', 'alert')),
    status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
    opened_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    closed_at INTEGER,
    value REAL,
    threshold REAL,
    n INTEGER,
    evidence_json TEXT
  )`,
  `CREATE UNIQUE INDEX bottlenecks_key ON bottlenecks (session_id, rule, subkey)`,
  `CREATE INDEX bottlenecks_session ON bottlenecks (session_id, status)`,
  `CREATE INDEX bottlenecks_opened_at ON bottlenecks (opened_at)`,
];
