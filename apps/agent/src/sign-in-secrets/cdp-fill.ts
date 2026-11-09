/**
 * Fills a secret into a field of a page in the browser Claude drives, over
 * the Chrome DevTools Protocol, so the value never goes through Claude.
 *
 * The browser must listen on a loopback debugging port: one started with
 * `--remote-debugging-port` (Chrome, Edge, Chromium; Playwright's
 * `connectOverCDP`), found from the running processes (the port in their
 * command line, or `DevToolsActivePort` in their profile folder), or named
 * with `cdp_url`. A browser driven over a pipe (Playwright's default launch)
 * cannot be reached: the error says so, so Claude can use the environment
 * instead.
 *
 * Only a page whose origin is the secret's site is filled, and the page
 * checks its own origin again in the same script that sets the value, so a
 * page that navigated away meanwhile is not filled.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { CdpConnection } from "../remote-browser/cdp-connection.ts";
import { originOf } from "./secret-names.ts";

const run = promisify(execFile);
const HTTP_TIMEOUT_MS = 2_000;

export class FillError extends Error {}

export interface PageTarget {
	url: string;
	webSocketDebuggerUrl: string;
}

/** Where the debugging endpoints may be; loopback only. */
export function loopbackEndpoint(input: string): string {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new FillError(`${input.slice(0, 200)} is not a URL; give the browser's debugging address as http://127.0.0.1:<port>`);
	}
	const host = url.hostname;
	if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") throw new FillError("tunelo only talks to a browser on this machine (127.0.0.1)");
	if (url.protocol !== "http:" && url.protocol !== "ws:") throw new FillError("the debugging address must be http://127.0.0.1:<port>");
	return `http://${host}:${url.port || "80"}`;
}

/** The debugging ports of browsers running now (command line, or DevToolsActivePort of their profile). */
export async function findDebugPorts(): Promise<number[]> {
	if (process.platform === "win32") {
		return portsFromCommandLines(await windowsCommandLines());
	}
	try {
		const { stdout } = await run("ps", ["-axww", "-o", "command="], { maxBuffer: 16 * 1024 * 1024, timeout: 5_000 });
		return portsFromCommandLines(stdout.split("\n"));
	} catch {
		return [];
	}
}

async function windowsCommandLines(): Promise<string[]> {
	try {
		const { stdout } = await run(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process -Filter \"CommandLine like '%remote-debugging-port%'\" | ForEach-Object { $_.CommandLine }"],
			{ windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
		);
		return stdout.split(/\r?\n/);
	} catch {
		return [];
	}
}

/** Ports named by `--remote-debugging-port=N` (N > 0), or read from DevToolsActivePort when N is 0. */
export function portsFromCommandLines(lines: readonly string[], readFile: (path: string) => string = (p) => readFileSync(p, "utf8")): number[] {
	const ports = new Set<number>();
	for (const line of lines) {
		const port = /--remote-debugging-port=(\d+)/.exec(line);
		if (!port?.[1]) continue;
		const n = Number(port[1]);
		if (n > 0 && n < 65536) {
			ports.add(n);
			continue;
		}
		const profile = /--user-data-dir=(?:"([^"]+)"|(\S+))/.exec(line);
		const dir = profile?.[1] ?? profile?.[2];
		if (!dir) continue;
		try {
			const first = Number(readFile(join(dir, "DevToolsActivePort")).split(/\r?\n/)[0]);
			if (first > 0 && first < 65536) ports.add(first);
		} catch {
			// the browser has not written it yet, or it is gone
		}
	}
	return [...ports];
}

async function getJson(url: string): Promise<unknown> {
	const res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

/** The pages of the browser at `endpoint` (http://127.0.0.1:port). */
export async function listPages(endpoint: string): Promise<PageTarget[]> {
	const list = await getJson(`${endpoint}/json/list`);
	if (!Array.isArray(list)) return [];
	return list.flatMap((t: unknown) => {
		const target = t as { type?: unknown; url?: unknown; webSocketDebuggerUrl?: unknown };
		return target.type === "page" && typeof target.url === "string" && typeof target.webSocketDebuggerUrl === "string"
			? [{ url: target.url, webSocketDebuggerUrl: target.webSocketDebuggerUrl }]
			: [];
	});
}

/**
 * Runs in the page: finds the field (the selector, else the focused field,
 * else the only visible password field), checks the page's origin, sets the
 * value the way a user's typing would, and says what happened, never the
 * value.
 */
const FILL_IN_PAGE = `function (selector, origin, value) {
	if (location.origin !== origin) return { ok: false, why: "origin", origin: location.origin };
	const fillable = (el) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
	let el = null;
	if (selector) {
		try { el = document.querySelector(selector); } catch (e) { return { ok: false, why: "selector" }; }
	} else if (fillable(document.activeElement) && document.activeElement.type !== "hidden") {
		el = document.activeElement;
	} else {
		const shown = [...document.querySelectorAll("input[type=password]")].filter((x) => x.offsetParent !== null);
		if (shown.length === 1) el = shown[0];
		else return { ok: false, why: shown.length ? "many" : "none" };
	}
	if (!el) return { ok: false, why: "none" };
	if (!fillable(el) || el.disabled || el.readOnly) return { ok: false, why: "field" };
	el.focus();
	const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
	setter.call(el, value);
	el.dispatchEvent(new Event("input", { bubbles: true }));
	el.dispatchEvent(new Event("change", { bubbles: true }));
	return { ok: true, field: el.name || el.id || el.type || el.tagName.toLowerCase() };
}`;

interface FillAnswer {
	ok: boolean;
	why?: string;
	origin?: string;
	field?: string;
}

const WHY: Record<string, string> = {
	selector: "the selector is not valid CSS",
	none: "no field to fill: give a selector, or focus the field first",
	many: "several password fields: give a selector",
	field: "that element is not a text field that can be filled",
};

/** Fills `value` into the page; throws FillError saying why not. */
export async function fillPage(page: PageTarget, origin: string, value: string, selector: string | undefined): Promise<{ field: string }> {
	let session: CdpConnection;
	try {
		session = await CdpConnection.open(page.webSocketDebuggerUrl);
	} catch (err) {
		throw new FillError(`could not attach to the page (${err instanceof Error ? err.message : String(err)})`);
	}
	try {
		const global = (await session.send("Runtime.evaluate", { expression: "globalThis" })) as { result?: { objectId?: string } };
		const objectId = global.result?.objectId;
		if (!objectId) throw new FillError("the page gave no script context");
		const called = (await session.send("Runtime.callFunctionOn", {
			objectId,
			functionDeclaration: FILL_IN_PAGE,
			arguments: [{ value: selector ?? "" }, { value: origin }, { value }],
			returnByValue: true,
			silent: true,
		})) as { result?: { value?: FillAnswer }; exceptionDetails?: unknown };
		const answer = called.result?.value;
		if (called.exceptionDetails || !answer) throw new FillError("the page's script failed");
		if (!answer.ok) {
			if (answer.why === "origin") throw new FillError(`the page moved to ${answer.origin ?? "another site"}; nothing was filled`);
			throw new FillError(WHY[answer.why ?? ""] ?? "nothing was filled");
		}
		return { field: answer.field ?? "field" };
	} finally {
		session.close();
	}
}

export interface FillTarget {
	/** Browsers to look in: the one named, else every one found running. */
	endpoints: string[];
	pages: PageTarget[];
}

/**
 * The pages of the browsers that can be reached. Throws FillError when no
 * browser listens on a debugging port.
 */
export async function reachablePages(cdpUrl: string | undefined, find: () => Promise<number[]> = findDebugPorts): Promise<FillTarget> {
	const endpoints = cdpUrl ? [loopbackEndpoint(cdpUrl)] : (await find()).map((port) => `http://127.0.0.1:${port}`);
	if (endpoints.length === 0) {
		throw new FillError(
			"no browser on this machine has a debugging port tunelo can reach (Playwright's default launch uses a pipe). Start the browser with --remote-debugging-port=<port> and pass cdp_url, or use the secret in a command as $TUNELO_SECRET_<NAME> instead",
		);
	}
	const settled = await Promise.allSettled(endpoints.map((e) => listPages(e)));
	const pages = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
	if (settled.every((s) => s.status === "rejected")) {
		throw new FillError(`the browser at ${endpoints.join(", ")} does not answer on its debugging port; or use $TUNELO_SECRET_<NAME> in a command`);
	}
	return { endpoints, pages };
}

/** The pages on `origin`, most recently active first (the browser's own order). */
export function pagesOn(pages: readonly PageTarget[], origin: string): PageTarget[] {
	return pages.filter((p) => originOf(p.url) === origin);
}
