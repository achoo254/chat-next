// How the Live Map's drawer, event detail and replay bar write their values
// in the UI language: clock times, durations, counts, tokens, cost, a
// finding's sentence, an event's one-line label (with "Ẩn chi tiết" hiding
// what the privacy filter kept: files, domains, commands, MCP names), and the
// comparison of a station's numbers with earlier sessions.
import type { LiveMapBottleneck, LiveMapEvent, StationNumbers } from "./live-map-types.ts";
import type { ObservatoryCopy } from "./observatory-copy.ts";

/** A clock time with seconds: "14:31:08". */
export function clock(c: ObservatoryCopy, ms: number): string {
	return new Intl.DateTimeFormat(c.locale, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(ms));
}

/** A date and time, short. */
export function moment(c: ObservatoryCopy, ms: number): string {
	return new Intl.DateTimeFormat(c.locale, { dateStyle: "short", timeStyle: "short" }).format(new Date(ms));
}

export function count(c: ObservatoryCopy, n: number): string {
	return new Intl.NumberFormat(c.locale).format(n);
}

/** Token counts, short: "396,5 N" / "396.5K". */
export function tokens(c: ObservatoryCopy, n: number): string {
	return new Intl.NumberFormat(c.locale, { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

/** "612 ms", "2,8 s", "3:05". */
export function duration(c: ObservatoryCopy, ms: number): string {
	if (ms < 1_000) return `${count(c, Math.round(ms))} ms`;
	if (ms < 60_000) return `${new Intl.NumberFormat(c.locale, { maximumFractionDigits: 1 }).format(ms / 1_000)} s`;
	const seconds = Math.round(ms / 1_000);
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** A share (0.07) as "7%". */
export function share(c: ObservatoryCopy, fraction: number): string {
	return new Intl.NumberFormat(c.locale, { style: "percent", maximumFractionDigits: 1 }).format(fraction);
}

/** A change in percent, signed: "+42%", "−8%". */
export function delta(c: ObservatoryCopy, percent: number): string {
	const rounded = Math.round(percent);
	const magnitude = new Intl.NumberFormat(c.locale).format(Math.abs(rounded));
	return rounded > 0 ? `+${magnitude}%` : rounded < 0 ? `−${magnitude}%` : "0%";
}

/** An estimate in US dollars, marked with `*`. */
export function usd(c: ObservatoryCopy, value: number): string {
	return `${new Intl.NumberFormat(c.locale, { style: "currency", currency: "USD", maximumFractionDigits: value < 1 ? 4 : 2 }).format(value)}*`;
}

/** failures / ended; null before any call ended. */
export function failureRate(n: Pick<StationNumbers, "failures" | "ended">): number | null {
	return n.ended > 0 ? n.failures / n.ended : null;
}

/** What the privacy filter kept of a tool call (`folder/name`, a domain, a program); "" when none. */
function targetOf(e: Extract<LiveMapEvent, { kind: "tool" }>): string {
	return "target" in e && typeof e.target === "string" ? e.target : "";
}

/** An event in one line. Hidden details leave out every filtered label and MCP name. */
export function eventLabel(c: ObservatoryCopy, e: LiveMapEvent, hideDetails: boolean): string {
	switch (e.kind) {
		case "prompt":
			return c.detail.kinds.prompt;
		case "tool": {
			if (hideDetails) return e.mcpServer !== "" ? c.detail.kinds.tool : e.toolName;
			const target = targetOf(e);
			// An MCP tool is named `mcp__<server>__<tool>`: shown as `server › tool`.
			const prefix = `mcp__${e.mcpServer}__`;
			const name = e.mcpServer === "" ? e.toolName : `${e.mcpServer} › ${e.toolName.startsWith(prefix) ? e.toolName.slice(prefix.length) : e.toolName}`;
			return target !== "" && target !== name ? `${name} · ${target}` : name;
		}
		case "subagent":
			return `${c.detail.kinds.subagent} ${e.agentType}`.trim();
		case "api":
			return `${c.detail.kinds.api} ${e.model}`.trim();
		case "instruction":
			return hideDetails ? c.detail.kinds.instruction : `${c.detail.kinds.instruction} ${e.memoryType}`.trim();
		case "git":
			return `${c.detail.kinds.git} ${e.gitKind}`.trim();
		case "lifecycle":
			return hideDetails || e.label === "" ? e.name : `${e.name} · ${e.label}`;
		case "bottleneck":
			return ruleName(c, e);
		default:
			return "";
	}
}

/** The rule's name; the API rule names its rate-limited case apart (it is always an alert, its slow case a warning). */
export function ruleName(c: ObservatoryCopy, b: Pick<LiveMapBottleneck, "rule" | "severity">): string {
	switch (b.rule) {
		case "tool_slow":
			return c.rules.tool_slow;
		case "api_slow_or_limited":
			return b.severity === "alert" ? c.rules.api_limited : c.rules.api_slow;
		case "repeat_read":
			return c.rules.repeat_read;
		case "context_high":
			return c.rules.context_high;
		case "mcp_errors":
			return c.rules.mcp_errors;
		case "subagent_idle":
			return c.rules.subagent_idle;
		case "cost_spike":
			return c.rules.cost_spike;
		default:
			return c.rules.unknown;
	}
}

/**
 * A finding's measure as its rule means it (apps/agent/src/observatory/bottlenecks/rules):
 * a duration, ms per output token or rate-limited requests, reads, a percent
 * of the context, a share of failed calls, tokens per minute, a turn's cost.
 */
export function findingValue(c: ObservatoryCopy, b: Pick<LiveMapBottleneck, "rule" | "severity">, value: number | undefined): string {
	if (value === undefined) return "—";
	switch (b.rule) {
		case "tool_slow":
			return duration(c, value);
		case "api_slow_or_limited":
			return b.severity === "alert" ? `${count(c, value)} ${c.units.limited}` : `${new Intl.NumberFormat(c.locale, { maximumFractionDigits: 1 }).format(value)} ${c.units.perToken}`;
		case "repeat_read":
			return `${count(c, value)} ${c.units.reads}`;
		case "context_high":
			return share(c, value / 100);
		case "mcp_errors":
			return share(c, value);
		case "subagent_idle":
			return `${tokens(c, value)} ${c.units.perMinute}`;
		case "cost_spike":
			// In dollars when the turns had Claude Code's estimate, else in tokens; the floors (1 USD, 2 million tokens) keep them far apart.
			return value < 100_000 ? usd(c, value) : tokens(c, value);
		default:
			return count(c, value);
	}
}

/** One line of the comparison with earlier sessions: the change in percent, null when there is nothing to compare. */
export interface Comparison {
	readonly metric: "p95" | "errors" | "tokens";
	readonly delta: number | null;
}

const average = (values: readonly number[]): number | null => (values.length === 0 ? null : values.reduce((s, v) => s + v, 0) / values.length);

const change = (current: number | null | undefined, baseline: number | null): number | null =>
	current === null || current === undefined || baseline === null || baseline <= 0 ? null : ((current - baseline) / baseline) * 100;

const tokensPerRequest = (n: StationNumbers): number | null => (n.apiRequests > 0 ? (n.inputTokens + n.outputTokens + n.cacheReadTokens + n.cacheWriteTokens) / n.apiRequests : null);

/**
 * The station's p95, failure rate and tokens per API request against the
 * average of earlier sessions (rates, not totals: the session may still run).
 * Tokens only where the station has API requests.
 */
export function compareWithPrevious(current: StationNumbers, previous: readonly StationNumbers[]): Comparison[] {
	const rows: Comparison[] = [
		{ metric: "p95", delta: change(current.p95Ms, average(previous.flatMap((p) => (p.p95Ms === undefined ? [] : [p.p95Ms])))) },
		{ metric: "errors", delta: change(failureRate(current), average(previous.flatMap((p) => { const r = failureRate(p); return r === null ? [] : [r]; }))) },
	];
	const earlierTokens = previous.flatMap((p) => { const t = tokensPerRequest(p); return t === null ? [] : [t]; });
	if (current.apiRequests > 0 || earlierTokens.length > 0) rows.push({ metric: "tokens", delta: change(tokensPerRequest(current), average(earlierTokens)) });
	return rows;
}
