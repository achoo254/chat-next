// How each Observatory row type (observatory-rows.ts) maps onto its table
// (schema-v1.ts): field, column and type, whether the column is required,
// how a second write of the same key merges into it, and what a write does
// on a duplicate. row-codec.ts builds the statements and converts values
// from these.
import type {
  ApiRequestRow,
  ContentSettingRow,
  DailyRollupRow,
  GitOpRow,
  InstructionLoadedRow,
  PromptRow,
  SessionRow,
  SubagentRow,
  ToolCallRow,
} from "./observatory-rows.ts";

export type ColumnType = "text" | "integer" | "real" | "boolean";

/**
 * How a write merges into the stored row of its key, so the result does not
 * depend on which source arrived first:
 * - `fill`: the new value when it has one, else the stored one;
 * - `first`: the stored value when there is one, else the new one;
 * - `min` / `max`: the smaller / larger of the two, ignoring a missing one;
 * - `unlessCertain` (the link to the previous session and its flag): `fill`,
 *   unless the stored link is a certain one (previous_session_inferred = 0).
 */
export type Merge = "fill" | "first" | "min" | "max" | "unlessCertain";

export type Column<R> = {
  readonly field: keyof R & string;
  readonly column: string;
  readonly type: ColumnType;
  /** NOT NULL in the schema: a write without it is refused before it reaches SQLite. */
  readonly required: boolean;
  readonly merge: Merge;
};

/**
 * What a write does when its row is already stored: `upsert` merges into the
 * row of `key` (column by column, see Merge); `ignore` keeps the stored row
 * (the table's unique constraints say what a duplicate is); `insert` has no
 * duplicates (only written by the store itself).
 */
export type Conflict<R> = { readonly upsert: readonly (keyof R & string)[] } | "ignore" | "insert";

export type TableSpec<R> = {
  readonly table: string;
  readonly conflict: Conflict<R>;
  readonly columns: readonly Column<R>[];
};

type ColumnOptions = { required?: boolean; merge?: Merge };

const col = <R>(field: keyof R & string, column: string, type: ColumnType, opts: ColumnOptions = {}): Column<R> => ({
  field,
  column,
  type,
  required: opts.required ?? false,
  merge: opts.merge ?? "fill",
});

/** The columns every event row has: its session (never changed once set) and its earliest time. */
const sessionOf = <R extends { sessionId: string }>() => col<R>("sessionId", "session_id", "text", { required: true, merge: "first" });
const earliest = <R>(field: keyof R & string, column: string) => col<R>(field, column, "integer", { required: true, merge: "min" });

export const SESSIONS: TableSpec<SessionRow> = {
  table: "sessions",
  conflict: { upsert: ["sessionId"] },
  columns: [
    col("sessionId", "session_id", "text", { required: true }),
    col("previousSessionId", "previous_session_id", "text", { merge: "unlessCertain" }),
    col("previousSessionInferred", "previous_session_inferred", "boolean", { merge: "unlessCertain" }),
    // The first project written for the session (where it started, unless its records came out of order): a later event in another folder (a `cd`) or one read again never moves it.
    col("projectKey", "project_key", "text", { merge: "first" }),
    col("cwd", "cwd", "text", { merge: "first" }),
    col("source", "source", "text", { required: true, merge: "first" }),
    col("internalLabel", "internal_label", "text"),
    earliest("startedAt", "started_at"),
    col("endedAt", "ended_at", "integer", { merge: "max" }),
    col("mainModel", "main_model", "text"),
  ],
};

export const PROMPTS: TableSpec<PromptRow> = {
  table: "prompts",
  conflict: { upsert: ["promptId"] },
  columns: [
    col("promptId", "prompt_id", "text", { required: true }),
    sessionOf(),
    earliest("at", "at"),
    col("length", "length", "integer"),
    col("excerpt", "excerpt", "text"),
    col("projectKey", "project_key", "text", { merge: "first" }),
  ],
};

export const TOOL_CALLS: TableSpec<ToolCallRow> = {
  table: "tool_calls",
  conflict: { upsert: ["toolUseId"] },
  columns: [
    col("toolUseId", "tool_use_id", "text", { required: true }),
    sessionOf(),
    col("promptId", "prompt_id", "text"),
    col("agentId", "agent_id", "text"),
    earliest("at", "at"),
    col("toolName", "tool_name", "text"),
    col("officeRoom", "office_room", "text"),
    col("mcpServer", "mcp_server", "text"),
    col("target", "target", "text"),
    col("durationMs", "duration_ms", "integer"),
    col("inputBytes", "input_bytes", "integer"),
    col("outputBytes", "output_bytes", "integer"),
    col("success", "success", "boolean"),
    col("error", "error", "text"),
    col("content", "content", "text"),
    // Written only with the content (the ingest's end-of-call writes), so the content's own project.
    col("projectKey", "project_key", "text", { merge: "first" }),
  ],
};

export const SUBAGENTS: TableSpec<SubagentRow> = {
  table: "subagents",
  // An agent id is only known to be unique within its session.
  conflict: { upsert: ["sessionId", "agentId"] },
  columns: [
    col("sessionId", "session_id", "text", { required: true }),
    col("agentId", "agent_id", "text", { required: true }),
    col("promptId", "prompt_id", "text"),
    col("agentType", "agent_type", "text"),
    earliest("startedAt", "started_at"),
    col("endedAt", "ended_at", "integer", { merge: "max" }),
    col("model", "model", "text"),
    col("totalTokens", "total_tokens", "integer"),
    col("toolCount", "tool_count", "integer"),
  ],
};

export const API_REQUESTS: TableSpec<ApiRequestRow> = {
  table: "api_requests",
  conflict: { upsert: ["dedupeKey"] },
  columns: [
    col("dedupeKey", "dedupe_key", "text", { required: true }),
    sessionOf(),
    col("promptId", "prompt_id", "text"),
    col("agentId", "agent_id", "text"),
    earliest("at", "at"),
    col("model", "model", "text"),
    col("inputTokens", "input_tokens", "integer"),
    col("outputTokens", "output_tokens", "integer"),
    col("cacheReadTokens", "cache_read_tokens", "integer"),
    col("cacheWrite5mTokens", "cache_write_5m_tokens", "integer"),
    col("cacheWrite1hTokens", "cache_write_1h_tokens", "integer"),
    col("costUsd", "cost_usd", "real"),
    col("durationMs", "duration_ms", "integer"),
    col("ttftMs", "ttft_ms", "integer"),
    col("querySource", "query_source", "text"),
  ],
};

export const INSTRUCTIONS_LOADED: TableSpec<InstructionLoadedRow> = {
  table: "instructions_loaded",
  conflict: "ignore",
  columns: [
    col("sessionId", "session_id", "text", { required: true }),
    col("seq", "seq", "integer", { required: true }),
    col("at", "at", "integer", { required: true }),
    col("filePath", "file_path", "text", { required: true }),
    col("memoryType", "memory_type", "text"),
    col("loadReason", "load_reason", "text", { required: true }),
  ],
};

export const GIT_OPS: TableSpec<GitOpRow> = {
  table: "git_ops",
  conflict: "ignore",
  columns: [
    col("sessionId", "session_id", "text", { required: true }),
    col("promptId", "prompt_id", "text"),
    col("at", "at", "integer", { required: true }),
    col("sha", "sha", "text"),
    col("branch", "branch", "text"),
    col("kind", "kind", "text", { required: true }),
  ],
};

export const CONTENT_SETTINGS: TableSpec<ContentSettingRow> = {
  table: "content_settings",
  conflict: { upsert: ["projectKey"] },
  columns: [
    col("projectKey", "project_key", "text", { required: true }),
    col("storeContent", "store_content", "boolean", { required: true }),
    col("updatedAt", "updated_at", "integer", { required: true }),
  ],
};

/** Read only: retention.ts writes the totals with its own statement. */
export const DAILY_ROLLUPS: TableSpec<DailyRollupRow> = {
  table: "daily_rollups",
  conflict: "insert",
  columns: [
    col("day", "day", "text", { required: true }),
    col("projectKey", "project_key", "text", { required: true }),
    col("model", "model", "text", { required: true }),
    col("sessions", "sessions", "integer"),
    col("prompts", "prompts", "integer"),
    col("toolCalls", "tool_calls", "integer"),
    col("toolFailures", "tool_failures", "integer"),
    col("subagents", "subagents", "integer"),
    col("apiRequests", "api_requests", "integer"),
    col("inputTokens", "input_tokens", "integer"),
    col("outputTokens", "output_tokens", "integer"),
    col("cacheReadTokens", "cache_read_tokens", "integer"),
    col("cacheWrite5mTokens", "cache_write_5m_tokens", "integer"),
    col("cacheWrite1hTokens", "cache_write_1h_tokens", "integer"),
    col("costUsd", "cost_usd", "real"),
    col("gitOps", "git_ops", "integer"),
  ],
};
