// The totals of the "Hiệu quả" page from a machine's UsageReport (remote.proto,
// "usage of the AIs"): the last 7 and 30 days, the 30 days before them, the
// mean context per main-session call and the share of calls the app opened.
// usage-insights.ts holds the page's other views. Pure: the page passes the
// report and today's day.
//
// The machine keys a repository by its origin remote as git has it, so rows
// are matched by the canonical key (git-remote.ts), the key the page and the
// projects use.
import type { UsageReport } from "@achoo254/chat-proto/remote/remote";
import { canonicalRemote } from "../git-remote.ts";

/** Days one report covers: the last 30, the 30 before them, and 30 more for the rules' trends. */
export const REPORT_DAYS = 90;
export const RECENT_DAYS = 30;
export const WEEK_DAYS = 7;

const SCRATCH_KEY = "scratch";
const LOCAL_PREFIX = "local:";

/** The page's key of a machine's repository key: `local:…` and `scratch` as they are, a remote by its canonical key. */
export function usageKeyOf(raw: string): string {
	if (raw === SCRATCH_KEY || raw.startsWith(LOCAL_PREFIX)) return raw;
	return canonicalRemote(raw) ?? raw;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** The local day of `date` as YYYY-MM-DD. */
export function dayOf(date: Date): string {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The day `delta` days after `day` (YYYY-MM-DD). */
export function shiftDay(day: string, delta: number): string {
	const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
	return dayOf(new Date(y, m - 1, d + delta));
}

/** The days a report asks for, both included, ending today. */
export function reportRange(today: string): { from: string; to: string } {
	return { from: shiftDay(today, -(REPORT_DAYS - 1)), to: today };
}

export interface UsageTotals {
	readonly mainTurns: number;
	readonly subagentTurns: number;
	readonly appTurns: number;
	readonly input: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly output: number;
	/** Mean context per main-session call; null without a call. */
	readonly meanContext: number | null;
}

export interface UsageSummary {
	/** No call of the key in the whole report. */
	readonly empty: boolean;
	readonly week: UsageTotals;
	readonly month: UsageTotals;
	/** The 30 days before the last 30. */
	readonly previous: UsageTotals;
	/** Share of the last 30 days' main-session calls the app opened, whole percent; null without a call. */
	readonly appPercent: number | null;
}

type Sum = { mainTurns: number; subagentTurns: number; appTurns: number; input: number; cacheRead: number; cacheWrite: number; output: number; context: number };

const zero = (): Sum => ({ mainTurns: 0, subagentTurns: 0, appTurns: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, context: 0 });

function totals(s: Sum): UsageTotals {
	const { context, ...rest } = s;
	return { ...rest, meanContext: s.mainTurns > 0 ? Math.round(context / s.mainTurns) : null };
}

/**
 * The page's numbers for `key` ("" for every repository) from `report`, with
 * `today` the device's day. A day's mean context is weighted by its calls
 * (the machine rounds each day's mean, so the result can be off by under one
 * token).
 */
export function summarize(report: UsageReport, key: string, today: string): UsageSummary {
	const wanted = key === "" ? "" : usageKeyOf(key);
	const weekFrom = shiftDay(today, -(WEEK_DAYS - 1));
	const monthFrom = shiftDay(today, -(RECENT_DAYS - 1));
	const previousFrom = shiftDay(today, -(2 * RECENT_DAYS - 1));
	const week = zero();
	const month = zero();
	const previous = zero();
	let calls = 0;
	for (const row of report.days) {
		if (wanted !== "" && usageKeyOf(row.repoKey) !== wanted) continue;
		calls += row.mainTurns + row.subagentTurns;
		const targets = row.day >= monthFrom ? (row.day >= weekFrom ? [week, month] : [month]) : row.day >= previousFrom ? [previous] : [];
		for (const t of targets) {
			t.mainTurns += row.mainTurns;
			t.subagentTurns += row.subagentTurns;
			t.appTurns += row.appTurns;
			t.input += Number(row.inputTokens);
			t.cacheRead += Number(row.cacheReadTokens);
			t.cacheWrite += Number(row.cacheWriteTokens);
			t.output += Number(row.outputTokens);
			t.context += Number(row.meanContext) * row.mainTurns;
		}
	}
	return {
		empty: calls === 0,
		week: totals(week),
		month: totals(month),
		previous: totals(previous),
		appPercent: month.mainTurns > 0 ? Math.round((100 * month.appTurns) / month.mainTurns) : null,
	};
}
