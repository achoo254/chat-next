// The store reads of the bottleneck runner, on its own read-only connection
// (bottleneck-runner.ts): one session's stored findings, open or closed (a
// restarted agent goes on from them), and the sessions that still have an
// open finding (closed when their session ended while the agent was off).
import type { BottleneckRow } from "../store/observatory-rows.ts";
import { BOTTLENECKS } from "../store/observatory-table-specs.ts";
import { decodeRow, selectList } from "../store/row-codec.ts";
import type { SqliteConnection } from "../store/sqlite-driver.ts";

/** Every finding stored for `sessionId`. */
export function readSessionFindings(db: SqliteConnection, sessionId: string): BottleneckRow[] {
  return db.all(`SELECT ${selectList(BOTTLENECKS)} FROM bottlenecks WHERE session_id = ?`, [sessionId]).map((raw) => decodeRow(BOTTLENECKS, raw));
}

/** Sessions with a finding still open, at most `limit`. */
export function readSessionsWithOpenFindings(db: SqliteConnection, limit: number): string[] {
  return db
    .all("SELECT DISTINCT session_id FROM bottlenecks WHERE status = 'open' LIMIT ?", [limit])
    .flatMap((r) => (typeof r.session_id === "string" ? [r.session_id] : []));
}
