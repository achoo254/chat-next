// The reads ObservatoryStore serves, over one connection: rows decoded by
// their table's spec (row-codec.ts), each list in a stable order.
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
import {
  API_REQUESTS,
  CONTENT_SETTINGS,
  DAILY_ROLLUPS,
  GIT_OPS,
  INSTRUCTIONS_LOADED,
  PROMPTS,
  SESSIONS,
  SUBAGENTS,
  TOOL_CALLS,
  type TableSpec,
} from "./observatory-table-specs.ts";
import { decodeRow, selectList } from "./row-codec.ts";
import type { SqlValue, SqliteConnection } from "./sqlite-driver.ts";

const MAX_SESSIONS_LISTED = 1_000;

export type SessionTimeline = {
  /** null when only the session's events are stored so far. */
  session: SessionRow | null;
  prompts: PromptRow[];
  toolCalls: ToolCallRow[];
  subagents: SubagentRow[];
  apiRequests: ApiRequestRow[];
  instructionsLoaded: InstructionLoadedRow[];
  gitOps: GitOpRow[];
};

export type SessionQuery = { from?: number; to?: number; limit?: number };
export type DayRange = { fromDay?: string; toDay?: string };

function select<R>(db: SqliteConnection, spec: TableSpec<R>, where: string, params: readonly SqlValue[]): R[] {
  return db.all(`SELECT ${selectList(spec)} FROM ${spec.table} ${where}`, params).map((raw) => decodeRow(spec, raw));
}

/** Sessions started in [from, to) (Unix ms), newest first, at most `limit` (up to 1000; 100 by default). */
export function readSessions(db: SqliteConnection, q: SessionQuery): SessionRow[] {
  const limit = Math.max(1, Math.min(MAX_SESSIONS_LISTED, Math.floor(q.limit ?? 100)));
  return select(db, SESSIONS, "WHERE started_at >= ? AND started_at < ? ORDER BY started_at DESC, session_id LIMIT ?", [q.from ?? 0, q.to ?? Number.MAX_SAFE_INTEGER, limit]);
}

/** Everything stored of one session, each list in time order. */
export function readSessionTimeline(db: SqliteConnection, sessionId: string): SessionTimeline {
  const bySession = "WHERE session_id = ? ORDER BY";
  const id = [sessionId];
  return {
    session: select(db, SESSIONS, "WHERE session_id = ?", id)[0] ?? null,
    prompts: select(db, PROMPTS, `${bySession} at, prompt_id`, id),
    toolCalls: select(db, TOOL_CALLS, `${bySession} at, tool_use_id`, id),
    subagents: select(db, SUBAGENTS, `${bySession} started_at, agent_id`, id),
    apiRequests: select(db, API_REQUESTS, `${bySession} at, dedupe_key`, id),
    instructionsLoaded: select(db, INSTRUCTIONS_LOADED, `${bySession} at, seq, file_path`, id),
    gitOps: select(db, GIT_OPS, `${bySession} at, rowid`, id),
  };
}

/** Rolled-up daily totals for days in [fromDay, toDay] (YYYY-MM-DD, both included). */
export function readDailyRollups(db: SqliteConnection, q: DayRange): DailyRollupRow[] {
  return select(db, DAILY_ROLLUPS, "WHERE day >= ? AND day <= ? ORDER BY day, project_key, model", [q.fromDay ?? "", q.toDay ?? "9999-12-31"]);
}

/** The number and time of each stored load of `filePath` for `loadReason` in a session, by number (the ingest goes on from them after a restart). */
export function readInstructionLoads(db: SqliteConnection, sessionId: string, filePath: string, loadReason: string): { seq: number; at: number }[] {
  return db
    .all("SELECT seq, at FROM instructions_loaded WHERE session_id = ? AND file_path = ? AND load_reason = ? ORDER BY seq", [sessionId, filePath, loadReason])
    .flatMap((r) => (typeof r.seq === "number" && typeof r.at === "number" ? [{ seq: r.seq, at: r.at }] : []));
}

export function readContentSetting(db: SqliteConnection, projectKey: string): ContentSettingRow | undefined {
  return select(db, CONTENT_SETTINGS, "WHERE project_key = ?", [projectKey])[0];
}
