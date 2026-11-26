// The usage report of a range of local days: one row per (repository key,
// day) with tokens by type, main and subagent calls, sessions, calls of
// sessions the app opened and the context per main-session call (mean,
// median, p90, as the baseline script computes them), plus the rules'
// suggestions that fired in the range (with when the hint was sent), plan
// usage readings, the last scan's time and the format check. With the AIs'
// model catalogs it adds rows per model with their cost at API prices, the
// sessions that cost most, and what each suggestion's habit cost. Numbers,
// rule codes, session ids, repository keys, model ids and days only: never a
// message, a title or a file's path.
import { type Catalogs, costOf, noCatalogs } from "./costs.ts";
import { DAY_MS, type Ledger, type LedgerIndex, type QuotaPoint, type ShapeFlags, type Turn, contextOf, localDay, median } from "./ledger.ts";
import { SCRATCH_KEY } from "./repo-key.ts";
import { type RuleCode, type RuleSwitches, evaluate } from "./rules.ts";

/** The longest range one report covers, in days. */
export const REPORT_MAX_DAYS = 92;
/** How far before the range a session's earlier calls are read, for the rules. */
const SESSION_LOOKBACK_MS = 31 * DAY_MS;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const KEY_MAX = 512;

export type ReportQuery = { from: string; to: string; repoKey?: string };

export type DayRow = {
  repoKey: string;
  day: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  mainTurns: number;
  subagentTurns: number;
  /** Sessions with a call (main or subagent) that day. */
  sessions: number;
  /** Main-session calls of sessions the app opened. */
  appTurns: number;
  meanContext: number;
  medianContext: number;
  p90Context: number;
};

/** One row per repository key, day and model. */
export type ModelDayRow = {
  repoKey: string;
  day: string;
  model: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  mainTurns: number;
  subagentTurns: number;
  /** At API prices, in dollars; 0 when the model's price is not known. */
  costUsd: number;
  /** The model's price is known. */
  priced: boolean;
};

/** A session with a call in the range: its calls in the range only. */
export type ReportSession = {
  provider: string;
  sessionId: string;
  repoKey: string;
  firstAt: number;
  lastAt: number;
  mainTurns: number;
  subagentTurns: number;
  /** The largest context of one main-session call. */
  peakContext: number;
  /** The model of most of its main-session calls. */
  model: string;
  costUsd: number;
  /** Calls whose model's price is not known (left out of costUsd). */
  unpricedTurns: number;
  /** The app opened it (a chat thread, its CLI in the machine's terminal). */
  app: boolean;
  /** The working directory of its last main-session call; never sent. */
  cwd: string;
  /** What it left in git (outcomes.ts); absent when not read or not a repository. */
  outcome?: { commits: number; filesChanged: number };
};

export type ReportSuggestion = {
  rule: RuleCode;
  sessionId: string;
  repoKey: string;
  turn: number;
  at: number;
  value: number;
  experimental: boolean;
  /** Unix milliseconds the hint was sent to devices; 0 when it was not. */
  notifiedAt: number;
  /** What the habit cost the session at API prices, in dollars; 0 when unknown. */
  excessUsd: number;
};

export type UsageReportData = {
  from: string;
  to: string;
  /** Minutes east of UTC of the machine's time zone, in which days are cut. */
  utcOffsetMinutes: number;
  lastScanAt: number;
  flags: ShapeFlags;
  days: DayRow[];
  modelDays: ModelDayRow[];
  /** The sessions that cost most in the range (then those with most calls), at most SESSIONS_MAX. */
  sessions: ReportSession[];
  suggestions: ReportSuggestion[];
  quota: QuotaPoint[];
};

/** Sessions a report lists. */
export const SESSIONS_MAX = 50;

/** A range a report cannot cover: dates not YYYY-MM-DD, from after to, too long, or a bad repository key. */
export class ReportRangeError extends Error {}

function dayStart(day: string): number {
  const m = DAY.exec(day);
  if (!m) throw new ReportRangeError(`not a YYYY-MM-DD day: ${day.slice(0, 20)}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) throw new ReportRangeError(`not a day: ${day}`);
  return date.getTime();
}

/** The local-time bounds of a query, [from, to) in Unix milliseconds; throws ReportRangeError. */
export function rangeOf(q: ReportQuery): { from: number; to: number } {
  const from = dayStart(q.from);
  const lastStart = dayStart(q.to);
  if (lastStart < from) throw new ReportRangeError("from is after to");
  const lastDate = new Date(lastStart);
  const to = new Date(lastDate.getFullYear(), lastDate.getMonth(), lastDate.getDate() + 1).getTime();
  // Days, not 24-hour spans: a daylight-saving change makes one 23 or 25 hours.
  if (Math.round((to - from) / DAY_MS) > REPORT_MAX_DAYS) throw new ReportRangeError(`a report covers at most ${REPORT_MAX_DAYS} days`);
  const key = q.repoKey ?? "";
  // eslint-disable-next-line no-control-regex
  if (key.length > KEY_MAX || /[\u0000-\u001f\u007f]/.test(key)) throw new ReportRangeError("not a repository key");
  return { from, to };
}

/** The repository key of a call's working directory, as the ledger first told it. */
export function repoOf(index: Pick<LedgerIndex, "dirs">, cwd: string): string {
  return (cwd ? index.dirs[cwd]?.repo : undefined) ?? SCRATCH_KEY;
}

/** The value at rank round(0.9 × (n − 1)) of the sorted values (as the baseline script); 0 for none. */
export function p90(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.round(0.9 * (sorted.length - 1)))] ?? 0;
}

type Bucket = Omit<DayRow, "sessions" | "meanContext" | "medianContext" | "p90Context"> & { sessionIds: Set<string>; contexts: number[] };

/**
 * The report from the ledger's index and its calls: `turns` holds at least
 * the calls in the range and the earlier calls of the sessions in it (for the
 * rules). Pure.
 */
export function buildReport(input: { index: LedgerIndex; turns: readonly Turn[]; query: ReportQuery; rules: RuleSwitches; now: number; catalogs?: Catalogs }): UsageReportData {
  const { index, turns, query, rules, now } = input;
  const catalogs = input.catalogs ?? noCatalogs;
  const { from, to } = rangeOf(query);
  const only = query.repoKey ?? "";
  const buckets = new Map<string, Bucket>();
  const models = new Map<string, ModelDayRow>();
  const sessions = new Map<string, ReportSession & { models: Map<string, number> }>();
  for (const t of turns) {
    if (t.at < from || t.at >= to) continue;
    const repoKey = repoOf(index, t.cwd);
    if (only && repoKey !== only) continue;
    const day = localDay(t.at);
    const cost = costOf(t, catalogs);
    const modelId = `${repoKey}\u0000${day}\u0000${t.model}`;
    let m = models.get(modelId);
    if (!m) {
      m = { repoKey, day, model: t.model, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, mainTurns: 0, subagentTurns: 0, costUsd: 0, priced: cost !== undefined };
      models.set(modelId, m);
    }
    m.input += t.input;
    m.cacheRead += t.cacheRead;
    m.cacheWrite += t.cacheWrite;
    m.output += t.output;
    m.costUsd += cost ?? 0;
    if (t.subagent) m.subagentTurns++;
    else m.mainTurns++;
    const sessionId = `${t.provider}\u0000${t.sessionId}`;
    let s = sessions.get(sessionId);
    if (!s) {
      s = {
        provider: t.provider,
        sessionId: t.sessionId,
        repoKey,
        firstAt: t.at,
        lastAt: t.at,
        mainTurns: 0,
        subagentTurns: 0,
        peakContext: 0,
        model: "",
        costUsd: 0,
        unpricedTurns: 0,
        app: index.launched[t.provider]?.[t.sessionId] !== undefined,
        cwd: t.cwd,
        models: new Map(),
      };
      sessions.set(sessionId, s);
    }
    s.firstAt = Math.min(s.firstAt, t.at);
    s.lastAt = Math.max(s.lastAt, t.at);
    s.costUsd += cost ?? 0;
    if (cost === undefined) s.unpricedTurns++;
    if (t.subagent) s.subagentTurns++;
    else {
      s.mainTurns++;
      s.peakContext = Math.max(s.peakContext, contextOf(t));
      s.models.set(t.model, (s.models.get(t.model) ?? 0) + 1);
      if (t.at >= s.lastAt) {
        s.cwd = t.cwd;
        s.repoKey = repoKey;
      }
    }
    const id = `${repoKey}\u0000${day}`;
    let b = buckets.get(id);
    if (!b) {
      b = { repoKey, day, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, mainTurns: 0, subagentTurns: 0, appTurns: 0, sessionIds: new Set(), contexts: [] };
      buckets.set(id, b);
    }
    b.input += t.input;
    b.cacheRead += t.cacheRead;
    b.cacheWrite += t.cacheWrite;
    b.output += t.output;
    b.sessionIds.add(`${t.provider}\u0000${t.sessionId}`);
    if (t.subagent) {
      b.subagentTurns++;
      continue;
    }
    b.mainTurns++;
    b.contexts.push(contextOf(t));
    if (index.launched[t.provider]?.[t.sessionId] !== undefined) b.appTurns++;
  }
  const days: DayRow[] = [...buckets.values()]
    .map(({ sessionIds, contexts, ...b }) => {
      const sum = contexts.reduce((s, c) => s + c, 0);
      const mid = median(contexts); // sorts contexts
      return {
        ...b,
        sessions: sessionIds.size,
        meanContext: contexts.length ? Math.round(sum / contexts.length) : 0,
        medianContext: Math.round(mid),
        p90Context: p90(contexts),
      };
    })
    .sort((a, b) => (a.day === b.day ? a.repoKey.localeCompare(b.repoKey) : a.day.localeCompare(b.day)));

  // Rules over the sessions that made a call in the range, as far as they went by its end.
  const inRange = new Set<string>();
  for (const t of turns) if (t.at >= from && t.at < to) inRange.add(`${t.provider}\u0000${t.sessionId}`);
  const sessionTurns = turns.filter((t) => t.at < to && inRange.has(`${t.provider}\u0000${t.sessionId}`));
  const suggestions: ReportSuggestion[] = [];
  for (const s of evaluate(sessionTurns, rules, catalogs)) {
    if (s.at < from || s.at >= to) continue;
    const repoKey = repoOf(index, s.cwd);
    if (only && repoKey !== only) continue;
    suggestions.push({
      rule: s.rule,
      sessionId: s.sessionId,
      repoKey,
      turn: s.turn,
      at: s.at,
      value: s.value,
      experimental: s.experimental,
      notifiedAt: index.notified[s.provider]?.[s.sessionId]?.[s.rule] ?? 0,
      excessUsd: s.excessUsd,
    });
  }
  suggestions.sort((a, b) => a.at - b.at);

  const topSessions: ReportSession[] = [...sessions.values()]
    .map(({ models: used, ...s }) => ({ ...s, model: [...used.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "" }))
    .sort((a, b) => b.costUsd - a.costUsd || b.mainTurns + b.subagentTurns - (a.mainTurns + a.subagentTurns) || a.sessionId.localeCompare(b.sessionId))
    .slice(0, SESSIONS_MAX);

  return {
    from: query.from,
    to: query.to,
    utcOffsetMinutes: -new Date(now).getTimezoneOffset(),
    lastScanAt: index.lastScanAt,
    flags: index.shape.flags,
    days,
    modelDays: [...models.values()].sort((a, b) => a.day.localeCompare(b.day) || a.repoKey.localeCompare(b.repoKey) || a.model.localeCompare(b.model)),
    sessions: topSessions,
    suggestions,
    quota: index.quota.filter((q) => q.at >= from && q.at < to),
  };
}

/**
 * The report of `query` from the ledger, reading only the months it needs;
 * sessions in `hidden` (lowercased ids: Advisor's own) are left out of it.
 * Throws ReportRangeError, or LedgerUnreadable while blocked.
 */
export async function usageReport(
  ledger: Ledger,
  query: ReportQuery,
  rules: RuleSwitches,
  now: number,
  hidden: ReadonlySet<string> = new Set(),
  catalogs: Catalogs = noCatalogs,
): Promise<UsageReportData> {
  const { from, to } = rangeOf(query);
  await ledger.open();
  const all = await ledger.turns({ from: from - SESSION_LOOKBACK_MS, to });
  const turns = hidden.size === 0 ? all : all.filter((t) => !hidden.has(t.sessionId.toLowerCase()));
  return buildReport({ index: ledger.snapshot(), turns, query, rules, now, catalogs });
}
