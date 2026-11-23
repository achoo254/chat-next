// The reads behind a device watching one session (observatory/hub/): the
// session's row and totals, its timeline paged from the newest back, and one
// stored row again after a write touched it. Timeline rows are read without
// their content: a prompt's excerpt and a tool call's content never leave
// this file, so nothing built on these reads can send them.
//
// A session's timeline is every row of the event tables, ordered by time,
// then by kind (TIMELINE_KINDS order), then by the row's key: a total order,
// so a page that starts where the last one ended skips nothing and repeats
// nothing, whatever rows share a millisecond.
import type { ApiRequestRow, GitOpRow, InstructionLoadedRow, PromptRow, SessionEventRow, SessionRow, SubagentRow, ToolCallRow } from "./observatory-rows.ts";
import { API_REQUESTS, GIT_OPS, INSTRUCTIONS_LOADED, PROMPTS, SESSION_EVENTS, SESSIONS, SUBAGENTS, TOOL_CALLS } from "./observatory-table-specs.ts";
import { decodeRow, selectList } from "./row-codec.ts";
import type { SqlRow, SqlValue, SqliteConnection } from "./sqlite-driver.ts";
import { ObservatoryStoreError } from "./store-errors.ts";
import { withStation } from "./store-reads.ts";
import type { WriteOp } from "./write-ops.ts";

/** Rows a timeline page holds at most. */
export const MAX_TIMELINE_PAGE = 500;

export type PromptMeta = Omit<PromptRow, "excerpt">;
export type ToolCallMeta = Omit<ToolCallRow, "content">;

/** One row of a session's timeline, without content; `at` and `key` place it (see the file's head). */
export type TimelineEntry = { at: number; key: string } & (
  | { kind: "prompt"; row: PromptMeta }
  | { kind: "toolCall"; row: ToolCallMeta }
  | { kind: "subagent"; row: SubagentRow }
  | { kind: "apiRequest"; row: ApiRequestRow }
  | { kind: "instructionLoaded"; row: InstructionLoadedRow }
  | { kind: "gitOp"; row: GitOpRow }
  | { kind: "sessionEvent"; row: SessionEventRow }
);

export type TimelineKind = TimelineEntry["kind"];

/** The kinds in their order among rows of the same millisecond. */
export const TIMELINE_KINDS: readonly TimelineKind[] = ["prompt", "toolCall", "subagent", "apiRequest", "instructionLoaded", "gitOp", "sessionEvent"];

/** A place in a session's timeline: a page before it holds the rows that sort before it. */
export type TimelinePlace = { at: number; kind: TimelineKind; key: string };

/** A page of a session's timeline, oldest first; `more`: older rows exist before the first. */
export type TimelinePage = { entries: TimelineEntry[]; more: boolean };

/**
 * A stored row a write touched, to be read again (readTimelineEntry). `id`
 * tells two refs to the same row apart from refs to others; the rest is for
 * this file only.
 */
export type TimelineRef = { readonly kind: TimelineKind; readonly sessionId: string; readonly id: string; readonly where: string; readonly params: readonly SqlValue[] };

/** A session's numbers as stored now. `costUsd` is null when no API request had a cost. */
export type SessionTotals = {
  prompts: number;
  toolCalls: number;
  toolFailures: number;
  subagents: number;
  apiRequests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  gitOps: number;
  sessionEvents: number;
  /** The newest row's time; null when none is stored. */
  lastEventAt: number | null;
};

/** Where each kind lives: its table, its columns, its time column and the SQL of its key. */
const TABLES: Record<TimelineKind, { table: string; columns: string; at: string; key: string }> = {
  prompt: { table: PROMPTS.table, columns: selectList(PROMPTS), at: "at", key: "prompt_id" },
  toolCall: { table: TOOL_CALLS.table, columns: selectList(TOOL_CALLS), at: "at", key: "tool_use_id" },
  subagent: { table: SUBAGENTS.table, columns: selectList(SUBAGENTS), at: "started_at", key: "agent_id" },
  apiRequest: { table: API_REQUESTS.table, columns: selectList(API_REQUESTS), at: "at", key: "dedupe_key" },
  // A load is told apart by its number, reason and file (its primary key); the number first, padded, keeps them in order.
  instructionLoaded: { table: INSTRUCTIONS_LOADED.table, columns: selectList(INSTRUCTIONS_LOADED), at: "at", key: "printf('%06d', seq) || ':' || load_reason || ':' || file_path" },
  // A commit has no key of its own but its row id, padded so it sorts as a number.
  gitOp: { table: GIT_OPS.table, columns: selectList(GIT_OPS), at: "at", key: "printf('%012d', id)" },
  sessionEvent: { table: SESSION_EVENTS.table, columns: selectList(SESSION_EVENTS), at: "at", key: "dedupe_key" },
};

const KIND_ORDER = new Map(TIMELINE_KINDS.map((k, i) => [k, i]));

function kindOrder(kind: TimelineKind): number {
  return KIND_ORDER.get(kind) ?? 0;
}

/** Sorts `a` before `b` in timeline order. */
export function compareTimeline(a: TimelinePlace, b: TimelinePlace): number {
  return a.at - b.at || kindOrder(a.kind) - kindOrder(b.kind) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

function placeOf(raw: SqlRow): { at: number; key: string } {
  const at = raw.tl_at;
  const key = raw.tl_key;
  if (typeof at !== "number" || typeof key !== "string") throw new ObservatoryStoreError("a timeline row has no time or key");
  return { at, key };
}

/** One row read as its kind, its content left out. */
function decodeEntry(kind: TimelineKind, raw: SqlRow): TimelineEntry {
  const place = placeOf(raw);
  switch (kind) {
    case "prompt": {
      const { excerpt: _excerpt, ...row } = decodeRow(PROMPTS, raw);
      return { ...place, kind, row };
    }
    case "toolCall": {
      const { content: _content, ...row } = withStation(decodeRow(TOOL_CALLS, raw));
      return { ...place, kind, row };
    }
    case "subagent":
      return { ...place, kind, row: decodeRow(SUBAGENTS, raw) };
    case "apiRequest":
      return { ...place, kind, row: decodeRow(API_REQUESTS, raw) };
    case "instructionLoaded":
      return { ...place, kind, row: decodeRow(INSTRUCTIONS_LOADED, raw) };
    case "gitOp":
      return { ...place, kind, row: decodeRow(GIT_OPS, raw) };
    case "sessionEvent":
      return { ...place, kind, row: decodeRow(SESSION_EVENTS, raw) };
  }
}

function selectEntries(db: SqliteConnection, kind: TimelineKind, where: string, params: readonly SqlValue[], tail = ""): TimelineEntry[] {
  const t = TABLES[kind];
  return db.all(`SELECT ${t.columns}, ${t.at} AS tl_at, ${t.key} AS tl_key FROM ${t.table} WHERE ${where}${tail}`, params).map((raw) => decodeEntry(kind, raw));
}

/** The newest `limit` rows of one kind that sort before `before` (every row when it is undefined), newest first. */
function newestOfKind(db: SqliteConnection, kind: TimelineKind, sessionId: string, before: TimelinePlace | undefined, limit: number): TimelineEntry[] {
  const t = TABLES[kind];
  let where = "session_id = ?";
  const params: SqlValue[] = [sessionId];
  if (before) {
    const order = kindOrder(kind) - kindOrder(before.kind);
    // A kind sorting before the cursor's keeps its rows of the cursor's millisecond; one after it does not.
    if (order < 0) {
      where += ` AND ${t.at} <= ?`;
      params.push(before.at);
    } else if (order > 0) {
      where += ` AND ${t.at} < ?`;
      params.push(before.at);
    } else {
      where += ` AND (${t.at} < ? OR (${t.at} = ? AND ${t.key} < ?))`;
      params.push(before.at, before.at, before.key);
    }
  }
  params.push(limit);
  return selectEntries(db, kind, where, params, " ORDER BY tl_at DESC, tl_key DESC LIMIT ?");
}

/** The `limit` (1 to MAX_TIMELINE_PAGE) newest rows of a session before `before` (the newest of all when undefined), oldest first. */
export function readTimelinePage(db: SqliteConnection, sessionId: string, before: TimelinePlace | undefined, limit: number): TimelinePage {
  const n = Math.max(1, Math.min(MAX_TIMELINE_PAGE, Math.floor(limit)));
  // One more than asked tells whether older rows remain.
  const newest = TIMELINE_KINDS.flatMap((kind) => newestOfKind(db, kind, sessionId, before, n + 1)).sort((a, b) => compareTimeline(b, a));
  return { entries: newest.slice(0, n).reverse(), more: newest.length > n };
}

/** The ref of the timeline row `op` writes; undefined for a write that is not one (a session, a finding, a setting). */
export function timelineRefOf(op: WriteOp): TimelineRef | undefined {
  const ref = (kind: TimelineKind, sessionId: string, where: string, params: SqlValue[]): TimelineRef => ({ kind, sessionId, id: `${kind}\u0000${params.join("\u0000")}`, where, params });
  switch (op.kind) {
    case "prompt":
      return ref("prompt", op.row.sessionId, "prompt_id = ?", [op.row.promptId]);
    case "toolCall":
      return ref("toolCall", op.row.sessionId, "tool_use_id = ?", [op.row.toolUseId]);
    case "subagent":
      return ref("subagent", op.row.sessionId, "session_id = ? AND agent_id = ?", [op.row.sessionId, op.row.agentId]);
    case "apiRequest":
      return ref("apiRequest", op.row.sessionId, "dedupe_key = ?", [op.row.dedupeKey]);
    case "instructionLoaded":
      return ref("instructionLoaded", op.row.sessionId, "session_id = ? AND file_path = ? AND load_reason = ? AND seq = ?", [op.row.sessionId, op.row.filePath, op.row.loadReason, op.row.seq]);
    case "gitOp": {
      const { sessionId, sha, kind, promptId, at } = op.row;
      // The same two keys the table's unique indexes use (schema-v1.ts).
      return sha != null
        ? ref("gitOp", sessionId, "session_id = ? AND sha = ? AND kind = ?", [sessionId, sha, kind])
        : ref("gitOp", sessionId, "session_id = ? AND sha IS NULL AND COALESCE(prompt_id, '') = ? AND at = ? AND kind = ?", [sessionId, promptId ?? "", at, kind]);
    }
    case "sessionEvent":
      return ref("sessionEvent", op.row.sessionId, "dedupe_key = ?", [op.row.dedupeKey]);
    default:
      return undefined;
  }
}

/** The row `ref` names as stored now; undefined when it is not (a write the store refused). */
export function readTimelineEntry(db: SqliteConnection, ref: TimelineRef): TimelineEntry | undefined {
  return selectEntries(db, ref.kind, ref.where, ref.params, " LIMIT 1")[0];
}

/** A session's own row; undefined while none is stored. */
export function readSession(db: SqliteConnection, sessionId: string): SessionRow | undefined {
  return db.all(`SELECT ${selectList(SESSIONS)} FROM ${SESSIONS.table} WHERE session_id = ?`, [sessionId]).map((raw) => decodeRow(SESSIONS, raw))[0];
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const orNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A session's numbers as stored now (every count 0 for a session with nothing stored). */
export function readSessionTotals(db: SqliteConnection, sessionId: string): SessionTotals {
  const counts = db.all(
    `SELECT
       (SELECT COUNT(*) FROM prompts WHERE session_id = ?) AS prompts,
       (SELECT COUNT(*) FROM tool_calls WHERE session_id = ?) AS tool_calls,
       (SELECT COUNT(*) FROM tool_calls WHERE session_id = ? AND success = 0) AS tool_failures,
       (SELECT COUNT(*) FROM subagents WHERE session_id = ?) AS subagents,
       (SELECT COUNT(*) FROM git_ops WHERE session_id = ?) AS git_ops,
       (SELECT COUNT(*) FROM session_events WHERE session_id = ?) AS session_events`,
    Array<SqlValue>(6).fill(sessionId),
  )[0];
  const api = db.all(
    `SELECT COUNT(*) AS n, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read,
       SUM(COALESCE(cache_write_5m_tokens, 0) + COALESCE(cache_write_1h_tokens, 0)) AS cache_write, SUM(cost_usd) AS cost
     FROM api_requests WHERE session_id = ?`,
    [sessionId],
  )[0];
  const last = db.all(
    `SELECT MAX(
       COALESCE((SELECT MAX(at) FROM prompts WHERE session_id = ?), 0),
       COALESCE((SELECT MAX(at) FROM tool_calls WHERE session_id = ?), 0),
       COALESCE((SELECT MAX(started_at) FROM subagents WHERE session_id = ?), 0),
       COALESCE((SELECT MAX(at) FROM api_requests WHERE session_id = ?), 0),
       COALESCE((SELECT MAX(at) FROM instructions_loaded WHERE session_id = ?), 0),
       COALESCE((SELECT MAX(at) FROM git_ops WHERE session_id = ?), 0),
       COALESCE((SELECT MAX(at) FROM session_events WHERE session_id = ?), 0)) AS last_at`,
    Array<SqlValue>(7).fill(sessionId),
  )[0];
  const lastAt = count(last?.last_at);
  return {
    prompts: count(counts?.prompts),
    toolCalls: count(counts?.tool_calls),
    toolFailures: count(counts?.tool_failures),
    subagents: count(counts?.subagents),
    apiRequests: count(api?.n),
    inputTokens: count(api?.input),
    outputTokens: count(api?.output),
    cacheReadTokens: count(api?.cache_read),
    cacheWriteTokens: count(api?.cache_write),
    costUsd: orNull(api?.cost),
    gitOps: count(counts?.git_ops),
    sessionEvents: count(counts?.session_events),
    lastEventAt: lastAt > 0 ? lastAt : null,
  };
}
