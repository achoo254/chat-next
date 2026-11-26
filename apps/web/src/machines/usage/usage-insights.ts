// The "Hiệu quả" page's views of a machine's UsageReport beyond the totals
// (usage-summary.ts): the last 30 days against the 30 before, the days as
// stacked series (by repository or by model), where the usage went (by
// repository, model or session), the rules' suggestions grouped per rule,
// what sessions left in git, and when a plan window fills at the pace it
// goes. Pure: the page passes the report, the key and today's day.
//
// A machine before tunelo 3.30.0 sends no rows per model, no sessions and no
// costs: every cost here is then null and the page hides what needs it.
import type { UsageQuotaPoint, UsageReport, UsageSession, UsageSuggestion } from "@achoo254/chat-proto/remote/remote";
import { UsageRule } from "@achoo254/chat-proto/remote/remote";
import { RECENT_DAYS, shiftDay, usageKeyOf } from "./usage-summary.ts";

/** Repositories or models drawn by name in the chart; the rest are one "other" band. */
export const TOP_GROUPS = 4;
/** Weeks of a rule's trend line. */
export const TREND_WEEKS = 5;
/** The thresholds of the machine's rules (apps/agent usage/rules.ts USAGE_RULES), for the page's words and the session meter. */
export const RULE_LIMITS = { maxContext: 300_000, maxTurns: 300 } as const;

/** The key of the band that holds every group past TOP_GROUPS. */
export const OTHER = "\u0000other";

/** One row of usage, from a model row (tunelo 3.30.0+) or, before it, a day row without a model. */
interface Row {
	readonly repoKey: string;
	readonly day: string;
	readonly model: string;
	readonly turns: number;
	readonly mainTurns: number;
	/** Input + cache read + cache write tokens. */
	readonly context: number;
	readonly cacheRead: number;
	readonly cost: number;
}

export type ChartMetric = "turns" | "context" | "cost";
export type GroupBy = "repo" | "model";

export interface Period {
	readonly turns: number;
	readonly mainTurns: number;
	readonly context: number;
	readonly cacheRead: number;
	/** Null before tunelo 3.30.0. */
	readonly cost: number | null;
}

export interface Breakdown {
	/** A repository key, a model id, or OTHER. */
	readonly key: string;
	readonly turns: number;
	readonly context: number;
	readonly cost: number | null;
	/** Share of the period, 0-1: of the cost when known, else of the context. */
	readonly share: number;
}

export interface Series {
	/** The last RECENT_DAYS days, oldest first. */
	readonly days: readonly string[];
	/** Bands, biggest first, OTHER last. */
	readonly groups: readonly string[];
	/** values[day][group]. */
	readonly values: readonly (readonly number[])[];
}

export interface RuleGroup {
	readonly rule: UsageRule;
	/** Sessions it fired in over the last 30 days. */
	readonly count: number;
	/** Sessions per week, oldest of TREND_WEEKS first. */
	readonly weekly: readonly number[];
	readonly trend: "up" | "down" | "flat";
	/** Null before tunelo 3.30.0. */
	readonly excessUsd: number | null;
	readonly experimental: boolean;
	/** The costliest (else the largest value) first. */
	readonly top: readonly UsageSuggestion[];
}

export interface Outcomes {
	/** Sessions whose folder is a git repository the machine could read. */
	readonly sessions: number;
	readonly commits: number;
	readonly filesChanged: number;
	/** Null without a commit or a cost. */
	readonly costPerCommit: number | null;
	/** Share of those sessions (of at least MIN_OUTCOME_TURNS calls) without a commit, 0-1. */
	readonly withoutCommit: number;
	/** Costly sessions with at most one commit, costliest first. */
	readonly costly: readonly UsageSession[];
}

export interface Insights {
	/** Rows per model came: costs and models are known. */
	readonly rich: boolean;
	readonly month: Period;
	readonly previous: Period;
	readonly repos: readonly Breakdown[];
	readonly models: readonly Breakdown[];
	readonly sessions: readonly UsageSession[];
	readonly rules: readonly RuleGroup[];
	readonly outcomes: Outcomes | null;
	readonly monthStart: number;
}

/** Rows of a breakdown table; the rest become one OTHER row. */
export const TABLE_ROWS = 10;

/** `rows` cut to TABLE_ROWS, the rest added up as one OTHER row (its count of groups in `others`). */
export function topRows(rows: readonly Breakdown[]): { rows: readonly Breakdown[]; others: number } {
	if (rows.length <= TABLE_ROWS) return { rows, others: 0 };
	const rest = rows.slice(TABLE_ROWS);
	const sum = (pick: (b: Breakdown) => number) => rest.reduce((s, b) => s + pick(b), 0);
	const other: Breakdown = { key: OTHER, turns: sum((b) => b.turns), context: sum((b) => b.context), cost: rest[0]?.cost === null ? null : sum((b) => b.cost ?? 0), share: sum((b) => b.share) };
	return { rows: [...rows.slice(0, TABLE_ROWS), other], others: rest.length };
}

/** Sessions shorter than this are left out of the "without a commit" share (a question, a look around). */
export const MIN_OUTCOME_TURNS = 5;

const dayMs = (day: string) => new Date(`${day}T00:00:00`).getTime();

function rowsOf(report: UsageReport): Row[] {
	if (report.modelDays.length > 0)
		return report.modelDays.map((m) => ({
			repoKey: usageKeyOf(m.repoKey),
			day: m.day,
			model: m.model,
			turns: m.mainTurns + m.subagentTurns,
			mainTurns: m.mainTurns,
			context: Number(m.inputTokens + m.cacheReadTokens + m.cacheWriteTokens),
			cacheRead: Number(m.cacheReadTokens),
			cost: m.costUsd,
		}));
	return report.days.map((d) => ({
		repoKey: usageKeyOf(d.repoKey),
		day: d.day,
		model: "",
		turns: d.mainTurns + d.subagentTurns,
		mainTurns: d.mainTurns,
		context: Number(d.inputTokens + d.cacheReadTokens + d.cacheWriteTokens),
		cacheRead: Number(d.cacheReadTokens),
		cost: 0,
	}));
}

const keep = (wanted: string) => (row: { repoKey: string }) => wanted === "" || usageKeyOf(row.repoKey) === wanted;

function period(rows: readonly Row[], rich: boolean): Period {
	let turns = 0;
	let mainTurns = 0;
	let context = 0;
	let cacheRead = 0;
	let cost = 0;
	for (const r of rows) {
		turns += r.turns;
		mainTurns += r.mainTurns;
		context += r.context;
		cacheRead += r.cacheRead;
		cost += r.cost;
	}
	return { turns, mainTurns, context, cacheRead, cost: rich ? cost : null };
}

/** Change of `now` against `before` in whole percent; null when `before` is 0 or unknown. */
export function changeOf(now: number | null, before: number | null): number | null {
	if (now === null || before === null || before <= 0) return null;
	return Math.round((100 * (now - before)) / before);
}

/** Share of the context read from the cache, 0-1; null without context. */
export const cacheShare = (p: Period): number | null => (p.context > 0 ? p.cacheRead / p.context : null);

function breakdown(rows: readonly Row[], keyOf: (r: Row) => string, rich: boolean): Breakdown[] {
	const by = new Map<string, { turns: number; context: number; cost: number }>();
	for (const r of rows) {
		const k = keyOf(r);
		const b = by.get(k) ?? { turns: 0, context: 0, cost: 0 };
		b.turns += r.turns;
		b.context += r.context;
		b.cost += r.cost;
		by.set(k, b);
	}
	const total = [...by.values()].reduce((s, b) => s + (rich ? b.cost : b.context), 0);
	return [...by.entries()]
		.map(([key, b]) => ({ key, turns: b.turns, context: b.context, cost: rich ? b.cost : null, share: total > 0 ? (rich ? b.cost : b.context) / total : 0 }))
		.sort((a, b) => b.share - a.share || b.turns - a.turns || a.key.localeCompare(b.key));
}

function ruleGroups(hints: readonly UsageSuggestion[], monthStart: number, today: string, rich: boolean): RuleGroup[] {
	const weekStart = (w: number) => dayMs(shiftDay(today, -(7 * (TREND_WEEKS - w) - 1)));
	const by = new Map<UsageRule, UsageSuggestion[]>();
	for (const h of hints) by.set(h.rule, [...(by.get(h.rule) ?? []), h]);
	const groups: RuleGroup[] = [];
	for (const [rule, list] of by) {
		const recent = list.filter((h) => Number(h.at) >= monthStart);
		const weekly = Array.from({ length: TREND_WEEKS }, (_, w) => list.filter((h) => Number(h.at) >= weekStart(w) && (w === TREND_WEEKS - 1 || Number(h.at) < weekStart(w + 1))).length);
		const last = weekly[TREND_WEEKS - 1] ?? 0;
		const before = weekly.slice(0, -1).reduce((s, n) => s + n, 0) / (TREND_WEEKS - 1);
		if (recent.length === 0 && last === 0) continue;
		groups.push({
			rule,
			count: recent.length,
			weekly,
			trend: last > before + 0.5 ? "up" : last < before - 0.5 ? "down" : "flat",
			excessUsd: rich ? recent.reduce((s, h) => s + h.excessUsd, 0) : null,
			experimental: list.some((h) => h.experimental),
			top: [...recent].sort((a, b) => b.excessUsd - a.excessUsd || Number(b.value - a.value)).slice(0, 3),
		});
	}
	return groups.sort((a, b) => a.rule - b.rule);
}

function outcomesOf(sessions: readonly UsageSession[]): Outcomes | null {
	const known = sessions.filter((s) => s.outcomeKnown);
	if (known.length === 0) return null;
	const commits = known.reduce((s, x) => s + x.commits, 0);
	const cost = known.reduce((s, x) => s + x.costUsd, 0);
	const sized = known.filter((s) => s.mainTurns >= MIN_OUTCOME_TURNS);
	return {
		sessions: known.length,
		commits,
		filesChanged: known.reduce((s, x) => s + x.filesChanged, 0),
		costPerCommit: commits > 0 && cost > 0 ? cost / commits : null,
		withoutCommit: sized.length > 0 ? sized.filter((s) => s.commits === 0).length / sized.length : 0,
		costly: [...sized]
			.filter((s) => s.commits <= 1 && s.costUsd > 0)
			.sort((a, b) => b.costUsd - a.costUsd)
			.slice(0, 3),
	};
}

/** The page's views of `report` for `key` ("" for every repository), `today` the device's day. */
export function insightsOf(report: UsageReport, key: string, today: string): Insights {
	const wanted = key === "" ? "" : usageKeyOf(key);
	const rich = report.modelDays.length > 0;
	const monthFrom = shiftDay(today, -(RECENT_DAYS - 1));
	const previousFrom = shiftDay(today, -(2 * RECENT_DAYS - 1));
	const rows = rowsOf(report).filter(keep(wanted));
	const month = rows.filter((r) => r.day >= monthFrom);
	const monthStart = dayMs(monthFrom);
	const sessions = report.sessions.filter((s) => keep(wanted)(s) && Number(s.lastAt) >= monthStart);
	const hints = report.suggestions.filter(keep(wanted));
	return {
		rich,
		month: period(month, rich),
		previous: period(
			rows.filter((r) => r.day >= previousFrom && r.day < monthFrom),
			rich,
		),
		repos: breakdown(month, (r) => r.repoKey, rich),
		models: rich ? breakdown(month, (r) => r.model, rich) : [],
		sessions,
		rules: ruleGroups(hints, monthStart, today, rich),
		outcomes: outcomesOf(sessions),
		monthStart,
	};
}

/** The last 30 days of `report` for `key`, one band per repository or model (TOP_GROUPS, then OTHER). */
export function seriesOf(report: UsageReport, key: string, today: string, by: GroupBy, metric: ChartMetric): Series {
	const wanted = key === "" ? "" : usageKeyOf(key);
	const days = Array.from({ length: RECENT_DAYS }, (_, i) => shiftDay(today, i - (RECENT_DAYS - 1)));
	const rows = rowsOf(report).filter((r) => keep(wanted)(r) && r.day >= (days[0] ?? ""));
	const valueOf = (r: Row) => (metric === "turns" ? r.turns : metric === "context" ? r.context : r.cost);
	const groupOf = (r: Row) => (by === "repo" ? r.repoKey : r.model);
	const totals = new Map<string, number>();
	for (const r of rows) totals.set(groupOf(r), (totals.get(groupOf(r)) ?? 0) + valueOf(r));
	const ranked = [...totals.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	const named = ranked.slice(0, TOP_GROUPS).map(([k]) => k);
	const groups = ranked.length > TOP_GROUPS ? [...named, OTHER] : named;
	const index = new Map(days.map((d, i) => [d, i]));
	const values = days.map(() => groups.map(() => 0));
	for (const r of rows) {
		const d = index.get(r.day);
		if (d === undefined) continue;
		const g = named.includes(groupOf(r)) ? named.indexOf(groupOf(r)) : groups.indexOf(OTHER);
		const line = values[d];
		if (g < 0 || line === undefined) continue;
		line[g] = (line[g] ?? 0) + valueOf(r);
	}
	return { days, groups, values };
}

/**
 * When the 5-hour window of the quota readings that share `resetsAt` reaches
 * 100% at the pace of the readings of the last 3 hours; null when it does
 * not rise, has too few readings, or fills only after it resets.
 */
export function fillsAt(points: readonly UsageQuotaPoint[], resetsAt: number, now: number): number | null {
	const window = points
		.filter((p) => p.fiveHour !== undefined && Number(p.fiveHour.resetsAt) === resetsAt && Number(p.at) >= now - 3 * 3_600_000 && Number(p.at) <= now)
		.sort((a, b) => Number(a.at - b.at));
	const first = window[0];
	const last = window[window.length - 1];
	if (first === undefined || last === undefined || first === last || first.fiveHour === undefined || last.fiveHour === undefined) return null;
	const rise = last.fiveHour.utilization - first.fiveHour.utilization;
	const span = Number(last.at - first.at);
	if (rise <= 0 || span <= 0) return null;
	const at = Number(last.at) + ((100 - last.fiveHour.utilization) * span) / rise;
	return at < resetsAt ? at : null;
}
