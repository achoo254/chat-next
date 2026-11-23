// What the bottleneck rules compare a session with: the machine's own
// history of the last HISTORY_DAYS, read from the store and kept in memory
// for REFRESH_MS, so a batch of writes scores against numbers already at
// hand and the store is read at most once per key every ten minutes.
//
// - a tool key's p95 duration (tool name, station, program or MCP server:
//   rules/tool-key.ts), read by tool name and grouped here;
// - a model's p95 of milliseconds per output token;
// - the cost of a project's latest turns (a prompt and every API call it
//   made), with their token totals for when a cost is missing.
//
// Sessions with an internal label (the Advisor's) are left out of every
// number. Each read takes at most MAX_ROWS rows, newest first.
import { stationOfTarget } from "../live-map/station-map.ts";
import type { SqlRow, SqliteConnection } from "../store/sqlite-driver.ts";
import { toolKeyOf } from "./rules/tool-key.ts";

export const HISTORY_DAYS = 90;
export const REFRESH_MS = 10 * 60_000;
/** Rows one history read takes at most (the newest). */
export const MAX_ROWS = 20_000;
/** A project's turns kept in memory: enough for the baseline of a turn after a few more. */
export const TURNS_KEPT = 60;

const DAY = 24 * 60 * 60_000;

export type Percentile = { p95: number; n: number };

/** One earlier turn of a project: its cost when every API call told one, and its tokens. */
export type TurnCost = { promptId: string; at: number; costUsd: number | null; tokens: number };

/** The p95 of `values` (nearest rank); undefined for none. */
export function p95(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)];
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Leaves out the sessions of the Advisor (an internal label) for a table aliased `t`. */
const NOT_INTERNAL = "NOT EXISTS (SELECT 1 FROM sessions s WHERE s.session_id = t.session_id AND s.internal_label IS NOT NULL)";

type Cached<T> = { at: number; value: T };

/** The rules' read of history; every method answers undefined (or nothing) while there is no store to read. */
export interface HistoryView {
  toolP95(toolName: string, key: string): Percentile | undefined;
  apiMsPerTokenP95(model: string): Percentile | undefined;
  /** The project's turns started before `before`, newest first, without `excludePromptId`. */
  projectTurns(projectKey: string, before: number, excludePromptId: string): TurnCost[];
}

export class HistoryPercentiles implements HistoryView {
  private readonly tools = new Map<string, Cached<Map<string, Percentile>>>();
  private readonly models = new Map<string, Cached<Percentile | undefined>>();
  private readonly projects = new Map<string, Cached<TurnCost[]>>();

  constructor(
    private readonly db: () => SqliteConnection | undefined,
    private readonly now: () => number,
    private readonly problems: (place: string, err: unknown) => void,
  ) {}

  /** Forgets every number (a wipe, a new store). */
  clear(): void {
    this.tools.clear();
    this.models.clear();
    this.projects.clear();
  }

  toolP95(toolName: string, key: string): Percentile | undefined {
    return this.cached(this.tools, toolName, this.readTool(toolName))?.get(key);
  }

  apiMsPerTokenP95(model: string): Percentile | undefined {
    return this.cached(this.models, model, this.readModel(model));
  }

  projectTurns(projectKey: string, before: number, excludePromptId: string): TurnCost[] {
    const turns = this.cached(this.projects, projectKey, this.readTurns(projectKey)) ?? [];
    return turns.filter((t) => t.at < before && t.promptId !== excludePromptId);
  }

  /** The value under `key`, read again when older than REFRESH_MS; undefined when the store cannot be read. */
  private cached<T>(cache: Map<string, Cached<T>>, key: string, read: (db: SqliteConnection) => T): T | undefined {
    const now = this.now();
    const hit = cache.get(key);
    if (hit && now - hit.at < REFRESH_MS) return hit.value;
    const db = this.db();
    if (!db) return hit?.value;
    try {
      const value = read(db);
      cache.set(key, { at: now, value });
      return value;
    } catch (err) {
      this.problems("bottleneck-history", err);
      // Tried again at the next refresh, not on every batch.
      if (hit) cache.set(key, { at: now, value: hit.value });
      return hit?.value;
    }
  }

  private since(): number {
    return this.now() - HISTORY_DAYS * DAY;
  }

  private readTool(toolName: string): (db: SqliteConnection) => Map<string, Percentile> {
    return (db) => {
      const rows = db.all(
        `SELECT t.duration_ms, t.station, t.target, t.mcp_server FROM tool_calls t
         WHERE t.tool_name = ? AND t.at >= ? AND t.duration_ms IS NOT NULL AND ${NOT_INTERNAL}
         ORDER BY t.at DESC LIMIT ?`,
        [toolName, this.since(), MAX_ROWS],
      );
      const byKey = new Map<string, number[]>();
      for (const r of rows) {
        const duration = num(r.duration_ms);
        if (duration === null) continue;
        const target = str(r.target);
        const station = str(r.station) ?? stationOfTarget(toolName, target ?? undefined).station;
        const key = toolKeyOf({ toolName, station, target, mcpServer: str(r.mcp_server) });
        const list = byKey.get(key) ?? [];
        list.push(duration);
        byKey.set(key, list);
      }
      const out = new Map<string, Percentile>();
      for (const [key, list] of byKey) out.set(key, { p95: p95(list) ?? 0, n: list.length });
      return out;
    };
  }

  private readModel(model: string): (db: SqliteConnection) => Percentile | undefined {
    return (db) => {
      const rows = db.all(
        `SELECT t.duration_ms, t.output_tokens FROM api_requests t
         WHERE t.model = ? AND t.at >= ? AND t.duration_ms IS NOT NULL AND t.output_tokens > 0 AND ${NOT_INTERNAL}
         ORDER BY t.at DESC LIMIT ?`,
        [model, this.since(), MAX_ROWS],
      );
      const perToken = rows.flatMap((r) => {
        const d = num(r.duration_ms);
        const out = num(r.output_tokens);
        return d !== null && out !== null && out > 0 ? [d / out] : [];
      });
      const value = p95(perToken);
      return value === undefined ? undefined : { p95: value, n: perToken.length };
    };
  }

  private readTurns(projectKey: string): (db: SqliteConnection) => TurnCost[] {
    return (db) => {
      const prompts = db.all(
        `SELECT p.prompt_id, p.session_id, p.at FROM prompts p JOIN sessions s ON s.session_id = p.session_id
         WHERE s.project_key = ? AND s.internal_label IS NULL AND p.at >= ?
         ORDER BY p.at DESC LIMIT ?`,
        [projectKey, this.since(), TURNS_KEPT],
      );
      const turns: TurnCost[] = [];
      for (const p of prompts) {
        const promptId = str(p.prompt_id);
        const sessionId = str(p.session_id);
        const at = num(p.at);
        if (promptId === null || sessionId === null || at === null) continue;
        const turn = turnOf(db.all("SELECT cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens FROM api_requests WHERE session_id = ? AND prompt_id = ?", [sessionId, promptId]));
        if (turn) turns.push({ promptId, at, ...turn });
      }
      return turns;
    };
  }
}

/** A turn's cost (null when a call told none) and tokens from its API calls; undefined for a turn without any. */
function turnOf(rows: readonly SqlRow[]): { costUsd: number | null; tokens: number } | undefined {
  if (rows.length === 0) return undefined;
  let cost: number | null = 0;
  let tokens = 0;
  for (const r of rows) {
    const c = num(r.cost_usd);
    cost = cost === null || c === null ? null : cost + c;
    tokens += (num(r.input_tokens) ?? 0) + (num(r.output_tokens) ?? 0) + (num(r.cache_read_tokens) ?? 0) + (num(r.cache_write_5m_tokens) ?? 0) + (num(r.cache_write_1h_tokens) ?? 0);
  }
  return { costUsd: cost, tokens };
}
