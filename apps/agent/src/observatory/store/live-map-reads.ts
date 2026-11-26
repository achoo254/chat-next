// The reads behind the Live Map's requests besides the timeline
// (observatory/hub/): the sessions of one tunelo thread, an event's stored
// content, a station's numbers (the drawer), and the session facts the live
// state needs that its newest events may not hold. Only the content read
// returns content, and it reads the project's setting first: a project with
// content off gives none, whether or not its stored content was cleared yet.
//
// A station's numbers are worked out on the indexes of the session's rows:
// counts and sums in SQL over every row; p50/p95 in TypeScript over at most
// MAX_SAMPLE durations, an even sample when there are more (flagged). A tool
// call stored without a station (by a build of the first schema) counts for
// the station its filtered target suggests (store-reads.ts withStation).
import type { SessionRow } from "./observatory-rows.ts";
import { SESSIONS } from "./observatory-table-specs.ts";
import { decodeRow, selectList } from "./row-codec.ts";
import type { SqlRow, SqlValue, SqliteConnection } from "./sqlite-driver.ts";
import { type RowFilter, type TimelineEntry, type TimelineKind, type TimelinePlace, compareTimeline, newestOfKind, selectTimelineEntries } from "./timeline-reads.ts";
import { contentBlocked } from "./write-ops.ts";

/** Durations a station's percentiles are worked out from at most. */
export const MAX_SAMPLE = 10_000;
/** Sessions a thread's listing follows at most (its segments and their /clear chains). */
export const MAX_THREAD_SESSIONS = 500;
/** Earlier sessions of the same project a station is compared with. */
export const PREVIOUS_SESSIONS = 5;
export const SLOWEST = 5;
export const RECENT = 20;
export const MAX_PARTS = 20;
const MAX_BOTTLENECKS = 50;
/** Ids in one `IN (…)` list. */
const IN_CHUNK = 400;

// --- a thread's sessions -------------------------------------------------------

function inList(n: number): string {
  return Array<string>(n).fill("?").join(", ");
}

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += IN_CHUNK) out.push(items.slice(i, i + IN_CHUNK));
  return out;
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * The sessions of a thread, newest first, at most `limit`: the sessions its
 * segments name (`seeds`) and every session linked to them through
 * `previous_session_id`, both ways: back to the sessions before a /clear,
 * forward to the ones after it (the thread may still name the session before
 * its last /clear). Seeds not stored yet are followed all the same.
 */
export function readThreadSessions(db: SqliteConnection, seeds: readonly string[], limit: number): SessionRow[] {
  const found = new Set(seeds.filter((s) => s !== ""));
  let frontier = [...found];
  while (frontier.length > 0 && found.size < MAX_THREAD_SESSIONS) {
    const next: string[] = [];
    for (const ids of chunks(frontier)) {
      const linked = [
        ...db.all(`SELECT previous_session_id AS id FROM sessions WHERE session_id IN (${inList(ids.length)}) AND previous_session_id IS NOT NULL`, ids),
        ...db.all(`SELECT session_id AS id FROM sessions WHERE previous_session_id IN (${inList(ids.length)})`, ids),
      ];
      for (const row of linked) {
        const id = text(row.id);
        if (id === undefined || found.has(id) || found.size >= MAX_THREAD_SESSIONS) continue;
        found.add(id);
        next.push(id);
      }
    }
    frontier = next;
  }
  const rows = chunks([...found]).flatMap((ids) => db.all(`SELECT ${selectList(SESSIONS)} FROM sessions WHERE session_id IN (${inList(ids.length)})`, ids).map((raw) => decodeRow(SESSIONS, raw)));
  rows.sort((a, b) => b.startedAt - a.startedAt || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
  return rows.slice(0, Math.max(1, Math.floor(limit)));
}

// --- content by event ----------------------------------------------------------

export type StoredContent = { state: "stored"; text: string } | { state: "off" | "none" | "notYet" };

const CONTENT_OF: Partial<Record<TimelineKind, { table: "prompts" | "tool_calls"; key: string; column: string }>> = {
  prompt: { table: "prompts", key: "prompt_id", column: "excerpt" },
  toolCall: { table: "tool_calls", key: "tool_use_id", column: "content" },
};

/**
 * The stored content of one timeline row of a session: `notYet` when the row
 * is not stored, `off` when its project keeps no content (the store's own
 * rule, write-ops.ts contentBlocked), `none` when nothing is kept (a kind
 * without content, content cleared or never stored).
 */
export function readContent(db: SqliteConnection, sessionId: string, kind: TimelineKind, key: string): StoredContent {
  const of = CONTENT_OF[kind];
  if (!of) return { state: "none" };
  const row = db.all(`SELECT ${of.column} AS content FROM ${of.table} WHERE ${of.key} = ? AND session_id = ?`, [key, sessionId])[0];
  if (!row) return { state: "notYet" };
  if (contentBlocked(db, of.table, of.key, key, null, sessionId)) return { state: "off" };
  const content = text(row.content);
  return content === undefined ? { state: "none" } : { state: "stored", text: content };
}

// --- session facts for the live state ------------------------------------------

export type LiveFacts = {
  openBottlenecks: number;
  /** The largest context of one main-thread API request in the session (model-window.ts). */
  largestContext: number;
};

export function readLiveFacts(db: SqliteConnection, sessionId: string): LiveFacts {
  const row = db.all(
    `SELECT (SELECT COUNT(*) FROM bottlenecks WHERE session_id = ? AND status = 'open') AS open,
            (SELECT MAX(COALESCE(input_tokens, 0) + COALESCE(cache_read_tokens, 0) + COALESCE(cache_write_5m_tokens, 0) + COALESCE(cache_write_1h_tokens, 0))
               FROM api_requests WHERE session_id = ? AND agent_id IS NULL) AS largest`,
    [sessionId, sessionId],
  )[0];
  return { openBottlenecks: num(row?.open), largestContext: num(row?.largest) };
}

// --- the older rows the live state still needs -----------------------------------

/** Session events that end a turn (hub/live-state.ts). */
const TURN_END_EVENTS: RowFilter = { where: "kind IN ('stop', 'stop_failure') OR (kind = 'notification' AND label = 'idle_prompt')", params: [] };
/** Session events that set the core's state (hub/live-state.ts). */
const CORE_EVENTS: RowFilter = {
  where:
    "kind IN ('permission_request', 'permission_decision', 'permission_denied', 'hook_block', 'compact_start', 'compact_end', 'stop', 'stop_failure') OR (kind = 'notification' AND label IN ('permission_prompt', 'idle_prompt'))",
  params: [],
};
/**
 * Requests Claude Code makes on the session's own thread for its side
 * features once a turn ends (the next prompt it suggests, the session's
 * title): no agent, but not the AI working either. The Live Map leaves them
 * out the same way (apps/web observatory live-map-types.ts SIDE_REQUESTS).
 */
export const SIDE_REQUESTS: readonly string[] = ["prompt_suggestion", "generate_session_title"];

/** The main thread's own requests, not its side features'. */
const MAIN_THREAD = `(agent_id IS NULL OR agent_id = '') AND COALESCE(query_source, '') NOT IN (${SIDE_REQUESTS.map((s) => `'${s}'`).join(", ")})`;

/**
 * The rows of a session sorting before `before` (the oldest of the newest
 * events its live state is worked out from) that still change that state,
 * oldest first: the newest row of each kind that sets the core's state, the
 * newest turn end (a stop, an idle prompt, a tool call ended
 * `interruptedError`), the subagents not stopped (the newest `limit`: a
 * subagent runs for long, and the newest subagent row is often another one
 * that already stopped), the tool calls not ended since it (the newest `limit`)
 * with the events that say they never ran, and the main thread's newest API
 * request and newest one with a speed. Folded before the newest events
 * (hub/live-state.ts), they give the state the whole session gives: the
 * calls still running, the core's state, the speed and the context, however
 * many events came after them.
 */
export function readLiveCarry(db: SqliteConnection, sessionId: string, before: TimelinePlace, limit: number, interruptedError: string): TimelineEntry[] {
  const newest = (kind: TimelineKind, filter?: RowFilter): TimelineEntry[] => newestOfKind(db, kind, sessionId, before, 1, filter);
  const stopped = newest("sessionEvent", TURN_END_EVENTS);
  // Only an interrupted call after the last stop can be the later end: the scan stops there.
  const ends = [...stopped, ...newest("toolCall", { where: "error = ? AND at >= ?", params: [interruptedError, stopped[0]?.at ?? 0] })];
  // Calls at the turn end's millisecond are read too: the fold puts each on its side of the end.
  const since = Math.max(0, ...ends.map((e) => e.at));
  const open = newestOfKind(db, "toolCall", sessionId, before, limit, { where: "success IS NULL AND at >= ?", params: [since] });
  const ids = open.map((e) => e.key);
  const notRun = chunks(ids).flatMap((part) => newestOfKind(db, "sessionEvent", sessionId, before, part.length, { where: `kind IN ('permission_denied', 'hook_block') AND tool_use_id IN (${inList(part.length)})`, params: part }));
  const rows = [
    ...newest("prompt"),
    ...newestOfKind(db, "subagent", sessionId, before, limit, { where: "ended_at IS NULL OR ended_at = 0", params: [] }),
    ...newest("toolCall"),
    ...newest("sessionEvent", CORE_EVENTS),
    ...newest("apiRequest", { where: MAIN_THREAD, params: [] }),
    ...newest("apiRequest", { where: `(${MAIN_THREAD}) AND output_tokens > 0 AND duration_ms > 0`, params: [] }),
    ...ends,
    ...open,
    ...notRun,
  ];
  const byPlace = new Map(rows.map((e) => [`${e.kind}\u0000${e.key}`, e]));
  return [...byPlace.values()].sort(compareTimeline);
}

// --- a station's numbers ---------------------------------------------------------

export type StationNumbers = {
  calls: number;
  failures: number;
  ended: number;
  p50Ms: number | null;
  p95Ms: number | null;
  sampled: boolean;
  apiRequests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  /** At least one counted API request had a cost. */
  hasCost: boolean;
  requestsWithoutCost: number;
};

/** What a part of a station is: the MCP server, the tool, the file (`folder/name`), the domain, the program, the model. */
export type PartKind = "mcp_server" | "tool" | "file" | "domain" | "program" | "model";

export type StationPart = { kind: PartKind; key: string; numbers: StationNumbers };

export type StationDrill = {
  numbers: StationNumbers;
  parts: StationPart[];
  slowest: TimelineEntry[];
  recent: TimelineEntry[];
  previous: { sessionId: string; startedAt: number; numbers: StationNumbers }[];
  bottlenecks: TimelineEntry[];
};

export type StationQuery = { sessionId: string; station: string; at?: number };

/** The column a station's tool calls are split by. */
function toolPartOf(station: string): { kind: PartKind; sql: string; field: "mcpServer" | "target" | "toolName" } {
  switch (station) {
    case "MCP":
      return { kind: "mcp_server", sql: "COALESCE(mcp_server, '')", field: "mcpServer" };
    case "FILES":
    case "MEMORY":
      return { kind: "file", sql: "COALESCE(target, '')", field: "target" };
    case "EXTERNAL":
      return { kind: "domain", sql: "COALESCE(target, '')", field: "target" };
    case "SANDBOX":
    case "TESTING":
    case "GIT":
      return { kind: "program", sql: "COALESCE(target, '')", field: "target" };
    default:
      return { kind: "tool", sql: "COALESCE(tool_name, '')", field: "toolName" };
  }
}

/**
 * The API requests whose tokens and cost a station counts: the main
 * thread's for CORE (the AI), the subagents' for ORCHESTRATOR, every one for
 * EXTERNAL (where each request is also a call); none for the others.
 */
function apiScopeOf(station: string): string | undefined {
  switch (station) {
    case "CORE":
      return "agent_id IS NULL";
    case "ORCHESTRATOR":
      return "agent_id IS NOT NULL";
    case "EXTERNAL":
      return "1";
    default:
      return undefined;
  }
}

function emptyNumbers(): StationNumbers {
  return {
    calls: 0,
    failures: 0,
    ended: 0,
    p50Ms: null,
    p95Ms: null,
    sampled: false,
    apiRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    hasCost: false,
    requestsWithoutCost: 0,
  };
}

/** The value at `p` (0..1) of ascending `sorted`, by nearest rank; null when empty. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
  return sorted[rank - 1] ?? null;
}

/** Counts, sums and sampled durations of one station of one session, by part. */
class Tally {
  readonly total = emptyNumbers();
  private readonly parts = new Map<string, { kind: PartKind; key: string; numbers: StationNumbers; durations: number[] }>();
  private readonly durations: number[] = [];
  sampled = false;

  part(kind: PartKind, key: string): StationNumbers {
    const id = `${kind}\u0000${key}`;
    let p = this.parts.get(id);
    if (!p) {
      p = { kind, key, numbers: emptyNumbers(), durations: [] };
      this.parts.set(id, p);
    }
    return p.numbers;
  }

  /** Calls of a part: counted into the part and the total. */
  calls(kind: PartKind, key: string, calls: number, failures: number, ended: number): void {
    for (const n of [this.total, this.part(kind, key)]) {
      n.calls += calls;
      n.failures += failures;
      n.ended += ended;
    }
  }

  duration(kind: PartKind, key: string, ms: number): void {
    this.durations.push(ms);
    this.parts.get(`${kind}\u0000${key}`)?.durations.push(ms);
  }

  /** API request sums into `n` (the total, or a model's part). */
  static api(n: StationNumbers, raw: SqlRow): void {
    const requests = num(raw.requests);
    const withoutCost = num(raw.without_cost);
    n.apiRequests += requests;
    n.inputTokens += num(raw.input);
    n.outputTokens += num(raw.output);
    n.cacheReadTokens += num(raw.cache_read);
    n.cacheWriteTokens += num(raw.cache_write);
    n.costUsd += num(raw.cost);
    n.requestsWithoutCost += withoutCost;
    if (requests > withoutCost) n.hasCost = true;
  }

  finish(): { numbers: StationNumbers; parts: StationPart[] } {
    const finishOne = (n: StationNumbers, durations: number[]): StationNumbers => {
      durations.sort((a, b) => a - b);
      return { ...n, p50Ms: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95), sampled: this.sampled };
    };
    const parts = [...this.parts.values()]
      .map((p) => ({ kind: p.kind, key: p.key, numbers: finishOne(p.numbers, p.durations) }))
      .sort((a, b) => b.numbers.calls - a.numbers.calls || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .slice(0, MAX_PARTS);
    return { numbers: finishOne(this.total, this.durations), parts };
  }
}

const API_SUMS = `COUNT(*) AS requests, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read,
  SUM(COALESCE(cache_write_5m_tokens, 0) + COALESCE(cache_write_1h_tokens, 0)) AS cache_write, SUM(cost_usd) AS cost, SUM(cost_usd IS NULL) AS without_cost`;

/** `where` and its parameters for the rows of a session up to `at` (every row when undefined); `atColumn` is the row's time. */
function scope(sessionId: string, at: number | undefined, atColumn = "at"): { where: string; params: SqlValue[] } {
  return at === undefined ? { where: "session_id = ?", params: [sessionId] } : { where: `session_id = ? AND ${atColumn} <= ?`, params: [sessionId, at] };
}

/** The tool calls a station's legacy rows hold: stored without a station, placed by their filtered target. */
function legacyCalls(db: SqliteConnection, q: StationQuery): TimelineEntry[] {
  const s = scope(q.sessionId, q.at);
  return selectTimelineEntries(db, "toolCall", `${s.where} AND station IS NULL`, s.params).filter((e) => e.kind === "toolCall" && e.row.station === q.station);
}

/** The station's numbers in one session, and by part. */
function tallyStation(db: SqliteConnection, q: StationQuery, legacy: readonly TimelineEntry[]): { numbers: StationNumbers; parts: StationPart[] } {
  const tally = new Tally();
  const part = toolPartOf(q.station);
  const s = scope(q.sessionId, q.at);
  const toolWhere = `${s.where} AND station = ?`;
  const toolParams = [...s.params, q.station];

  let timed = 0;
  for (const raw of db.all(
    `SELECT ${part.sql} AS part, COUNT(*) AS calls, SUM(success = 0) AS failures, SUM(success IS NOT NULL) AS ended, SUM(duration_ms IS NOT NULL) AS timed
     FROM tool_calls WHERE ${toolWhere} GROUP BY part`,
    toolParams,
  )) {
    tally.calls(part.kind, text(raw.part) ?? "", num(raw.calls), num(raw.failures), num(raw.ended));
    timed += num(raw.timed);
  }
  for (const e of legacy) {
    if (e.kind !== "toolCall") continue;
    tally.calls(part.kind, e.row[part.field] ?? "", 1, e.row.success === false ? 1 : 0, e.row.success === null ? 0 : 1);
  }

  const apiScope = apiScopeOf(q.station);
  const apiCalls = q.station === "EXTERNAL";
  if (apiScope !== undefined) Tally.api(tally.total, db.all(`SELECT ${API_SUMS} FROM api_requests WHERE ${s.where} AND ${apiScope}`, s.params)[0] ?? {});
  if (apiCalls) {
    // Each request is a call of its model; each API error a failed one (an error leaves no request row).
    for (const raw of db.all(`SELECT COALESCE(model, '') AS part, ${API_SUMS}, SUM(duration_ms IS NOT NULL) AS timed FROM api_requests WHERE ${s.where} GROUP BY part`, s.params)) {
      const requests = num(raw.requests);
      tally.calls("model", text(raw.part) ?? "", requests, 0, requests);
      Tally.api(tally.part("model", text(raw.part) ?? ""), raw);
      timed += num(raw.timed);
    }
    for (const raw of db.all(`SELECT COALESCE(label, '') AS part, COUNT(*) AS errors FROM session_events WHERE ${s.where} AND kind = 'api_error' GROUP BY part`, s.params)) {
      const errors = num(raw.errors);
      tally.calls("model", text(raw.part) ?? "", errors, errors, errors);
    }
  }

  // Durations: every one, or an even sample of MAX_SAMPLE by time.
  const step = Math.max(1, Math.ceil(timed / MAX_SAMPLE));
  tally.sampled = step > 1;
  const sample = (table: string, key: string, partSql: string, where: string, params: SqlValue[]): SqlRow[] =>
    db.all(
      `SELECT d, part FROM (SELECT duration_ms AS d, ${partSql} AS part, ROW_NUMBER() OVER (ORDER BY at, ${key}) AS rn FROM ${table} WHERE ${where} AND duration_ms IS NOT NULL)
       WHERE (rn - 1) % ? = 0`,
      [...params, step],
    );
  for (const raw of sample("tool_calls", "tool_use_id", part.sql, toolWhere, toolParams)) tally.duration(part.kind, text(raw.part) ?? "", num(raw.d));
  if (apiCalls) for (const raw of sample("api_requests", "dedupe_key", "COALESCE(model, '')", s.where, s.params)) tally.duration("model", text(raw.part) ?? "", num(raw.d));
  for (const e of legacy) if (e.kind === "toolCall" && e.row.durationMs !== null) tally.duration(part.kind, e.row[part.field] ?? "", e.row.durationMs);
  return tally.finish();
}

const durationOf = (e: TimelineEntry): number => (e.kind === "toolCall" || e.kind === "apiRequest" ? (e.row.durationMs ?? -1) : -1);

/** The station's slowest calls, slowest first. */
function slowestOf(db: SqliteConnection, q: StationQuery, legacy: readonly TimelineEntry[]): TimelineEntry[] {
  const s = scope(q.sessionId, q.at);
  const tail = ` AND duration_ms IS NOT NULL ORDER BY duration_ms DESC, tl_key LIMIT ${SLOWEST}`;
  const found = [...selectTimelineEntries(db, "toolCall", `${s.where} AND station = ?${tail}`, [...s.params, q.station]), ...legacy];
  if (q.station === "EXTERNAL") found.push(...selectTimelineEntries(db, "apiRequest", `${s.where}${tail}`, s.params));
  return found
    .filter((e) => durationOf(e) >= 0)
    .sort((a, b) => durationOf(b) - durationOf(a) || compareTimeline(a, b))
    .slice(0, SLOWEST);
}

/** The station's newest calls and lifecycle events, newest first. */
function recentOf(db: SqliteConnection, q: StationQuery, legacy: readonly TimelineEntry[]): TimelineEntry[] {
  const s = scope(q.sessionId, q.at);
  const tail = ` ORDER BY tl_at DESC, tl_key DESC LIMIT ${RECENT}`;
  const found = [
    ...selectTimelineEntries(db, "toolCall", `${s.where} AND station = ?${tail}`, [...s.params, q.station]),
    ...selectTimelineEntries(db, "sessionEvent", `${s.where} AND station = ?${tail}`, [...s.params, q.station]),
    ...legacy,
  ];
  if (q.station === "EXTERNAL") found.push(...selectTimelineEntries(db, "apiRequest", `${s.where}${tail}`, s.params));
  return found.sort((a, b) => compareTimeline(b, a)).slice(0, RECENT);
}

/** Up to PREVIOUS_SESSIONS sessions of the same project started before this one, not internal, the newest first. */
function previousSessions(db: SqliteConnection, sessionId: string): { sessionId: string; startedAt: number }[] {
  const own = db.all("SELECT project_key, started_at FROM sessions WHERE session_id = ?", [sessionId])[0];
  const project = text(own?.project_key);
  if (!own || project === undefined) return [];
  return db
    .all(
      `SELECT session_id, started_at FROM sessions
       WHERE project_key = ? AND started_at < ? AND session_id != ? AND internal_label IS NULL
       ORDER BY started_at DESC, session_id LIMIT ?`,
      [project, num(own.started_at), sessionId, PREVIOUS_SESSIONS],
    )
    .flatMap((r) => (typeof r.session_id === "string" ? [{ sessionId: r.session_id, startedAt: num(r.started_at) }] : []));
}

/** The numbers of one station of a session (the Live Map's drawer); `q.at` limits them to what happened up to then. */
export function readStation(db: SqliteConnection, q: StationQuery): StationDrill {
  const legacy = legacyCalls(db, q);
  const { numbers, parts } = tallyStation(db, q, legacy);
  const previous = previousSessions(db, q.sessionId).map((p) => {
    const prev = { sessionId: p.sessionId, station: q.station };
    return { ...p, numbers: tallyStation(db, prev, legacyCalls(db, prev)).numbers };
  });
  const b = scope(q.sessionId, q.at, "opened_at");
  const bottlenecks = selectTimelineEntries(db, "bottleneck", `${b.where} AND station = ?`, [...b.params, q.station], ` ORDER BY status = 'open' DESC, updated_at DESC LIMIT ${MAX_BOTTLENECKS}`);
  return { numbers, parts, slowest: slowestOf(db, q, legacy), recent: recentOf(db, q, legacy), previous, bottlenecks };
}

