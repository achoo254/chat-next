// Retention of the Observatory database: detail rows (sessions with their
// working directory included) are kept RETENTION_DAYS days, then counted
// into `daily_rollups`, kept for good, and deleted. One pass handles at most
// `limit` rows of each table, so a scheduled run never holds the database
// (or the event loop) long; `more` tells the caller to run again.
//
// A session goes only once it has expired (by its end, or its start when it
// never ended) AND no row of it is left in any other table: a session
// resumed later (`claude --resume` keeps its id) or one whose SessionEnd
// never came lives as long as its newest event. So a child row always finds
// its session's project when it is counted.
//
// Rows of a session with an internal label (the Advisor's) are deleted
// without being counted: they are kept out of every statistic.
//
// A row's day is its calendar day in `timeZone` (default: the machine's at
// the time of the pass), written as YYYY-MM-DD text. A day once rolled up
// stays as written: changing the machine's time zone later moves only rows
// rolled up after the change.
import type { DailyRollupRow } from "./observatory-rows.ts";
import { dayFormatter, machineTimeZone } from "./rollup-day.ts";
import type { SqlRow, SqliteConnection } from "./sqlite-driver.ts";
import { ObservatoryStoreError } from "./store-errors.ts";

export const RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60_000;
/** Rows of each table one pass handles at most. */
export const DEFAULT_PRUNE_LIMIT = 500;

type Counts = Omit<DailyRollupRow, "day" | "projectKey" | "model">;

/** A detail table: its time, project and model as SQL over the table aliased `t`, what else it reads, and what one row adds to its day. */
type Expiring = {
  table: string;
  time: string;
  project: string;
  /** '' for rows counted under no model. */
  model: string;
  /** 1 when the row belongs to a session with an internal label. */
  internal: string;
  /** More conditions a row must meet to expire (SQL over `t`). */
  also: string;
  reads: readonly string[];
  add: (c: Counts, row: SqlRow) => void;
};

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** A child row's project is its session's ('' when the session is not stored). */
const child = (table: string, time: string, model: string, reads: readonly string[], add: Expiring["add"]): Expiring => ({
  table,
  time: `t.${time}`,
  project: "(SELECT s.project_key FROM sessions s WHERE s.session_id = t.session_id)",
  model,
  internal: "EXISTS (SELECT 1 FROM sessions s WHERE s.session_id = t.session_id AND s.internal_label IS NOT NULL)",
  also: "",
  reads,
  add,
});

const CHILDREN: readonly Expiring[] = [
  child("prompts", "at", "''", [], (c) => void c.prompts++),
  child("tool_calls", "at", "''", ["success"], (c, r) => {
    c.toolCalls++;
    if (r.success === 0) c.toolFailures++;
  }),
  child("subagents", "started_at", "COALESCE(t.model, '')", [], (c) => void c.subagents++),
  child("api_requests", "at", "COALESCE(t.model, '')", ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_5m_tokens", "cache_write_1h_tokens", "cost_usd"], (c, r) => {
    c.apiRequests++;
    c.inputTokens += n(r.input_tokens);
    c.outputTokens += n(r.output_tokens);
    c.cacheReadTokens += n(r.cache_read_tokens);
    c.cacheWrite5mTokens += n(r.cache_write_5m_tokens);
    c.cacheWrite1hTokens += n(r.cache_write_1h_tokens);
    c.costUsd += n(r.cost_usd);
  }),
  child("git_ops", "at", "''", [], (c) => void c.gitOps++),
  // Which instruction files loaded is not counted; the rows only expire.
  child("instructions_loaded", "at", "''", [], () => undefined),
];

const SESSIONS: Expiring = {
  table: "sessions",
  time: "COALESCE(t.ended_at, t.started_at)",
  project: "t.project_key",
  model: "COALESCE(t.main_model, '')",
  internal: "t.internal_label IS NOT NULL",
  also: CHILDREN.map((c) => ` AND NOT EXISTS (SELECT 1 FROM ${c.table} c WHERE c.session_id = t.session_id)`).join(""),
  reads: [],
  add: (c) => void c.sessions++,
};

export type PruneResult = {
  /** Detail rows deleted, by table. */
  deleted: Record<string, number>;
  /** Some expired rows are left: run again. */
  more: boolean;
};

const zero = (): Counts => ({
  sessions: 0,
  prompts: 0,
  toolCalls: 0,
  toolFailures: 0,
  subagents: 0,
  apiRequests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  costUsd: 0,
  gitOps: 0,
});

/** The count columns of daily_rollups, in the order pruneExpired binds them. */
const COUNT_COLUMNS = [
  "sessions",
  "prompts",
  "tool_calls",
  "tool_failures",
  "subagents",
  "api_requests",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_5m_tokens",
  "cache_write_1h_tokens",
  "cost_usd",
  "git_ops",
];
const ROLLUP_UPSERT = `INSERT INTO daily_rollups (day, project_key, model, ${COUNT_COLUMNS.join(", ")})
  VALUES (${["day", "project_key", "model", ...COUNT_COLUMNS].map(() => "?").join(", ")})
  ON CONFLICT (day, project_key, model) DO UPDATE SET ${COUNT_COLUMNS.map((c) => `${c} = ${c} + excluded.${c}`).join(", ")}`;

/** Counts up to `limit` expired rows of `e` into `rollups` (unless internal) and deletes them; how many. */
function expire(db: SqliteConnection, e: Expiring, cutoff: number, limit: number, dayOf: (ms: number) => string, rollups: Map<string, DailyRollupRow>): number {
  const where = `${e.time} < ?${e.also}`;
  const extra = e.reads.map((c) => `, t.${c} AS ${c}`).join("");
  const rows = db.all(
    `SELECT ${e.time} AS at, COALESCE(${e.project}, '') AS project_key, ${e.model} AS model, ${e.internal} AS internal${extra}
     FROM ${e.table} t WHERE ${where} ORDER BY ${e.time}, t.rowid LIMIT ?`,
    [cutoff, limit],
  );
  for (const r of rows) {
    if (r.internal === 1) continue;
    const day = dayOf(n(r.at));
    const projectKey = typeof r.project_key === "string" ? r.project_key : "";
    const model = typeof r.model === "string" ? r.model : "";
    const id = JSON.stringify([day, projectKey, model]);
    let entry = rollups.get(id);
    if (!entry) rollups.set(id, (entry = { day, projectKey, model, ...zero() }));
    e.add(entry, r);
  }
  // The same rows as the SELECT above: same filter and order, same transaction.
  db.run(`DELETE FROM ${e.table} WHERE rowid IN (SELECT t.rowid FROM ${e.table} t WHERE ${where} ORDER BY ${e.time}, t.rowid LIMIT ?)`, [cutoff, limit]);
  return rows.length;
}

/**
 * One retention pass at `now` (Unix ms), at most `limit` rows per table
 * (a positive integer). Runs inside the caller's transaction: the counts and
 * the deletions land together or not at all.
 */
export function pruneExpired(db: SqliteConnection, now: number, limit: number = DEFAULT_PRUNE_LIMIT, timeZone: string = machineTimeZone()): PruneResult {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new ObservatoryStoreError(`the retention limit must be a positive integer, not ${String(limit)}`);
  if (!Number.isFinite(now)) throw new ObservatoryStoreError(`the retention time must be a finite number, not ${String(now)}`);
  const dayOf = dayFormatter(timeZone);
  const cutoff = now - RETENTION_DAYS * DAY_MS;
  const rollups = new Map<string, DailyRollupRow>();
  const deleted: Record<string, number> = {};
  let more = false;
  // Children first: a session goes in the same pass as its last rows.
  for (const e of [...CHILDREN, SESSIONS]) {
    const count = expire(db, e, cutoff, limit, dayOf, rollups);
    deleted[e.table] = count;
    if (count === limit) more = true;
  }
  for (const r of rollups.values()) {
    db.run(ROLLUP_UPSERT, [
      r.day,
      r.projectKey,
      r.model,
      r.sessions,
      r.prompts,
      r.toolCalls,
      r.toolFailures,
      r.subagents,
      r.apiRequests,
      r.inputTokens,
      r.outputTokens,
      r.cacheReadTokens,
      r.cacheWrite5mTokens,
      r.cacheWrite1hTokens,
      r.costUsd,
      r.gitOps,
    ]);
  }
  return { deleted, more };
}
