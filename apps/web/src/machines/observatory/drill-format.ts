// How the Live Map writes its values in the UI language: clock times,
// durations, counts, a finding's rule, an event's one-line label
// (with "Ẩn chi tiết" hiding what the privacy filter kept: files, domains,
// commands, MCP names).
import type { LiveMapBottleneck, LiveMapEvent } from "./live-map-types.ts";
import type { ObservatoryCopy } from "./observatory-copy.ts";

/** A clock time with seconds: "14:31:08". */
export function clock(c: ObservatoryCopy, ms: number): string {
	return new Intl.DateTimeFormat(c.locale, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(ms));
}

export function count(c: ObservatoryCopy, n: number): string {
	return new Intl.NumberFormat(c.locale).format(n);
}

/** "612 ms", "2,8 s", "3:05". */
export function duration(c: ObservatoryCopy, ms: number): string {
	if (ms < 1_000) return `${count(c, Math.round(ms))} ms`;
	if (ms < 60_000) return `${new Intl.NumberFormat(c.locale, { maximumFractionDigits: 1 }).format(ms / 1_000)} s`;
	const seconds = Math.round(ms / 1_000);
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** What the privacy filter kept of a tool call (`folder/name`, a domain, a program); "" when none. */
function targetOf(e: Extract<LiveMapEvent, { kind: "tool" }>): string {
	return "target" in e && typeof e.target === "string" ? e.target : "";
}

/**
 * A tool's name where "Ẩn chi tiết" applies (the card, the boards, the name
 * tags, the event's line): an MCP tool's name (`mcp__<server>__<tool>`) names
 * the server, so hidden details show the generic "tool" instead.
 */
export function toolName(c: ObservatoryCopy, tool: string, mcpServer: string, hideDetails: boolean): string {
	return hideDetails && mcpServer !== "" ? c.detail.kinds.tool : tool;
}

/** An event in one line. Hidden details leave out every filtered label and MCP name. */
export function eventLabel(c: ObservatoryCopy, e: LiveMapEvent, hideDetails: boolean): string {
	switch (e.kind) {
		case "prompt":
			return c.detail.kinds.prompt;
		case "tool": {
			if (hideDetails) return toolName(c, e.toolName, e.mcpServer, true);
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
