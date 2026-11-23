// Every table of the Observatory database at SCHEMA_VERSION (migrate.ts),
// across all its versions, in the order an export lists them. A table a later
// version adds is appended to this list in the same change as its migration.

export const OBSERVATORY_TABLES = [
  "sessions",
  "prompts",
  "tool_calls",
  "subagents",
  "api_requests",
  "instructions_loaded",
  "git_ops",
  "session_events",
  "bottlenecks",
  "content_settings",
  "daily_rollups",
  "meta",
] as const;

export type ObservatoryTable = (typeof OBSERVATORY_TABLES)[number];
