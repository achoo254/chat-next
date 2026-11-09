/**
 * tunelo's own browser profile for Claude: a Chrome (or Chromium, Edge,
 * Brave) user data folder inside tunelo's config folder (0700), apart from
 * the user's own profiles, so sign-ins made in it stay between sessions. It
 * runs with a debugging port on loopback chosen by the browser
 * (`--remote-debugging-port=0`, read back from `DevToolsActivePort`).
 *
 * macOS: the profile uses a mock keychain, so the browser never asks the
 * login keychain (no dialog on a machine nobody sits at); its cookies are
 * only as safe as the folder, which other users cannot read.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CdpConnection } from "./cdp-connection.ts";

const START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 10_000;
const HTTP_TIMEOUT_MS = 1_500;

/** Where a running profile browser answers. */
export interface BrowserEndpoint {
	port: number;
	/** The browser-level DevTools WebSocket. */
	wsUrl: string;
	headless: boolean;
}

export class BrowserUnavailable extends Error {}

export function profileDir(configDir: string): string {
	return join(configDir, "browser-profile");
}

/** Browsers tunelo can run, most wanted first, for this platform. */
export function browserCandidates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
	if (platform === "darwin") {
		return [
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
		].flatMap((p) => [p, ...(env.HOME ? [join(env.HOME, p)] : [])]);
	}
	if (platform === "win32") {
		const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter((r): r is string => Boolean(r));
		return [
			...roots.map((r) => join(r, "Google", "Chrome", "Application", "chrome.exe")),
			...roots.map((r) => join(r, "Microsoft", "Edge", "Application", "msedge.exe")),
			...roots.map((r) => join(r, "Chromium", "Application", "chrome.exe")),
		];
	}
	return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium", "/usr/bin/microsoft-edge"];
}

/** The browser to run: `TUNELO_BROWSER` when set, else the first one installed. */
export function findBrowser(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string | undefined {
	const chosen = env.TUNELO_BROWSER;
	if (chosen) return exists(chosen) ? chosen : undefined;
	return browserCandidates(process.platform, env).find((p) => exists(p));
}

/** The command line of the profile browser. */
export function browserArgs(dir: string, headless: boolean, platform: NodeJS.Platform = process.platform): string[] {
	return [
		`--user-data-dir=${dir}`,
		"--remote-debugging-port=0",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-search-engine-choice-screen",
		// Nobody may be looking at the machine: a hidden or covered window still draws and takes input.
		"--disable-backgrounding-occluded-windows",
		"--disable-renderer-backgrounding",
		"--disable-background-timer-throttling",
		...(platform === "darwin" ? ["--use-mock-keychain"] : []),
		...(platform === "linux" ? ["--password-store=basic"] : []),
		...(headless ? ["--headless=new", "--window-size=1280,800"] : []),
		"about:blank",
	];
}

async function versionOf(port: number): Promise<{ wsUrl: string; headless: boolean } | undefined> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
		if (!res.ok) return undefined;
		const v = (await res.json()) as { webSocketDebuggerUrl?: unknown; "User-Agent"?: unknown };
		if (typeof v.webSocketDebuggerUrl !== "string") return undefined;
		const url = new URL(v.webSocketDebuggerUrl);
		// Only a browser on this machine.
		if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return undefined;
		return { wsUrl: v.webSocketDebuggerUrl, headless: String(v["User-Agent"] ?? "").includes("HeadlessChrome") };
	} catch {
		return undefined;
	}
}

function activePort(dir: string): number | undefined {
	try {
		const port = Number(readFileSync(join(dir, "DevToolsActivePort"), "utf8").split(/\r?\n/)[0]);
		return port > 0 && port < 65536 ? port : undefined;
	} catch {
		return undefined;
	}
}

/** The pid holding the profile (macOS, Linux: the SingletonLock link names host-pid). */
export function lockPid(dir: string): number | undefined {
	try {
		const pid = Number(/-(\d+)$/.exec(readlinkSync(join(dir, "SingletonLock")))?.[1]);
		return pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** The profile browser when it runs now (its port answers, and on macOS/Linux its lock holder lives). */
export async function runningBrowser(dir: string): Promise<BrowserEndpoint | undefined> {
	const port = activePort(dir);
	if (!port) return undefined;
	if (process.platform !== "win32") {
		const pid = lockPid(dir);
		if (!pid || !alive(pid)) return undefined;
	}
	const v = await versionOf(port);
	return v ? { port, ...v } : undefined;
}

function waitForPort(dir: string, child: ChildProcess, ms: number): Promise<BrowserEndpoint | undefined> {
	return new Promise((resolve) => {
		let done = false;
		const finish = (v: BrowserEndpoint | undefined) => {
			if (done) return;
			done = true;
			clearInterval(poll);
			clearTimeout(timer);
			resolve(v);
		};
		child.once("exit", () => finish(undefined));
		const timer = setTimeout(() => finish(undefined), ms);
		const poll = setInterval(() => {
			const port = activePort(dir);
			if (!port) return;
			void versionOf(port).then((v) => {
				if (v) finish({ port, ...v });
			});
		}, 200);
	});
}

/**
 * Starts the profile browser and waits for its debugging port. With a
 * screen it shows a window; when that fails (no one is signed in to the
 * machine's desktop) it starts headless.
 */
export async function launchBrowser(dir: string, exe: string): Promise<BrowserEndpoint> {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") chmodSync(dir, 0o700);
	for (const headless of process.env.TUNELO_BROWSER_HEADLESS === "1" ? [true] : [false, true]) {
		rmSync(join(dir, "DevToolsActivePort"), { force: true });
		const child = spawn(exe, browserArgs(dir, headless), { stdio: "ignore", detached: process.platform !== "win32", windowsHide: true });
		child.on("error", () => undefined);
		child.unref();
		const endpoint = await waitForPort(dir, child, START_TIMEOUT_MS);
		if (endpoint) return endpoint;
		if (child.exitCode === null) child.kill();
	}
	throw new BrowserUnavailable(`${exe} did not start with a debugging port`);
}

/** Closes the profile browser if it runs; true when one was closed. */
export async function stopBrowser(dir: string): Promise<boolean> {
	const running = await runningBrowser(dir);
	if (!running) return false;
	const pid = process.platform === "win32" ? undefined : lockPid(dir);
	try {
		const cdp = await CdpConnection.open(running.wsUrl);
		await cdp.send("Browser.close").catch(() => undefined);
		cdp.close();
	} catch {
		// not answering: the pid below
	}
	for (const end = Date.now() + STOP_TIMEOUT_MS; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) {
		if (!(await runningBrowser(dir))) return true;
	}
	if (pid && alive(pid)) process.kill(pid, "SIGKILL");
	return true;
}

/** Deletes the profile (every sign-in in it); closes the browser first. */
export async function clearProfile(dir: string): Promise<{ closed: boolean; removed: boolean }> {
	const closed = await stopBrowser(dir);
	const removed = existsSync(dir);
	// The browser may still be letting go of its files for a moment.
	rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	return { closed, removed };
}
