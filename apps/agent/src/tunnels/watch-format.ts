import chalk from "chalk";
import type { InspectorEntry, InspectorEntrySummary } from "./request-store.js";

/** What `tunelo watch` shows of a tunnel's traffic. */
export interface WatchFilter {
	/** One subdomain of a process carrying several. */
	subdomain?: string;
	/** `2xx`, `4xx`, `5xx` or a code such as `404`. */
	status?: string;
	/** Text the path must contain (case-insensitive). */
	path?: string;
}

const STATUS_FILTER = /^[1-5](xx|\dx|\d\d)$/i;

/** Whether `--status` is a class (`5xx`, `40x`) or a code (`404`). */
export function isStatusFilter(value: string): boolean {
	return STATUS_FILTER.test(value);
}

export function matchesFilter(
	entry: InspectorEntrySummary,
	filter: WatchFilter,
): boolean {
	if (filter.subdomain && entry.subdomain !== filter.subdomain) return false;
	if (filter.status) {
		const prefix = filter.status.replace(/x/gi, "");
		if (!String(entry.status).startsWith(prefix)) return false;
	}
	if (filter.path) {
		const text = filter.path.toLowerCase();
		if (!entry.path.toLowerCase().includes(text)) return false;
	}
	return true;
}

function paintStatus(status: number): string {
	const text = String(status);
	if (status >= 500) return chalk.red(text);
	if (status >= 400) return chalk.yellow(text);
	if (status >= 300) return chalk.cyan(text);
	return chalk.green(text);
}

/** `16:01:03  GET     200    12ms  /path  sub`: one request, one line. */
export function formatLine(
	entry: InspectorEntrySummary,
	showSubdomain: boolean,
): string {
	const time = new Date(entry.timestamp).toLocaleTimeString("en-GB", {
		hour12: false,
	});
	const duration = `${Math.round(entry.durationMs)}ms`.padStart(7);
	const replay = entry.entryType === "replay" ? chalk.dim(" (replay)") : "";
	const subdomain =
		showSubdomain && entry.subdomain ? chalk.dim(`  ${entry.subdomain}`) : "";
	return `${chalk.dim(time)}  ${entry.method.padEnd(7)} ${paintStatus(entry.status)} ${duration}  ${entry.path}${replay}${subdomain}`;
}

const BODY_LIMIT = 4096;

function headerLines(
	marker: string,
	headers: Record<string, string | string[]>,
): string[] {
	return Object.entries(headers).map(
		([name, value]) =>
			`    ${marker} ${name}: ${Array.isArray(value) ? value.join(", ") : value}`,
	);
}

function bodyLines(marker: string, body: string | null): string[] {
	if (!body) return [];
	const shown =
		body.length > BODY_LIMIT
			? `${body.slice(0, BODY_LIMIT)}\n… (${body.length - BODY_LIMIT} more characters, see the inspector)`
			: body;
	return shown.split("\n").map((line) => `    ${marker} ${line}`);
}

/** Headers (`>` sent, `<` received) and bodies under a request's line. */
export function formatDetails(
	entry: InspectorEntry,
	options: { headers: boolean; body: boolean },
): string[] {
	const lines: string[] = [];
	if (options.headers) lines.push(...headerLines(">", entry.requestHeaders));
	if (options.body) lines.push(...bodyLines(">", entry.requestBody));
	if (options.headers) lines.push(...headerLines("<", entry.responseHeaders));
	if (options.body) lines.push(...bodyLines("<", entry.responseBody));
	return lines.map((line) => chalk.dim(line));
}
