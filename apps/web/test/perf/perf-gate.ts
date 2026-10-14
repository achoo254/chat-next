// Perf gate of the web app (plan phase 06): fails when the startup bundle or
// the measured UI timings break their budgets (budgets.ts).
//
//   node test/perf/perf-gate.ts            bundle budget, then browser run
//   node test/perf/perf-gate.ts bundle     bundle budget only
//   node test/perf/perf-gate.ts browser    browser run only
//
// The bundle check builds the app with a manifest into a temp directory and
// sums the gzip size of what a signed-in start loads. The browser run builds
// the visual harness, serves it with `vite preview`, and drives its perf page
// (test/visual/perf.tsx) in Playwright's Chromium under each CPU profile.
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { build, preview } from "vite";
import { BUNDLE_BUDGET, PROFILES, SCENARIO, STARTUP_MODULES, type Profile } from "./budgets.ts";
import { measure, parseManifest, startupFiles, totalGzip } from "./bundle.ts";
import { PERF_SEED, type OpenSample, type ScrollSample } from "./perf-api.ts";
import { frameStats, longTaskStats, percentile } from "./stats.ts";

const APP_DIR = fileURLToPath(new URL("../../", import.meta.url));
const HARNESS_CONFIG = join(APP_DIR, "test/visual/vite.config.ts");
const HARNESS_PORT = 5174;
const KB = 1024;

interface Row {
	readonly check: string;
	readonly value: string;
	readonly budget: string;
	/** null: reported only. */
	readonly pass: boolean | null;
}

const rows: Row[] = [];

function row(check: string, value: number, unit: string, budget: number | null, pass: (value: number, budget: number) => boolean): void {
	const digits = unit === "KB" ? 1 : 0;
	rows.push({
		check,
		value: `${value.toFixed(digits)} ${unit}`,
		budget: budget === null ? "-" : `${budget.toFixed(digits)} ${unit}`,
		pass: budget === null ? null : pass(value, budget),
	});
}

const atMost = (value: number, budget: number) => value <= budget;
const atLeast = (value: number, budget: number) => value >= budget;

// ------------------------------------------------------------- bundle

async function bundleCheck(): Promise<void> {
	const outDir = await mkdtemp(join(tmpdir(), "web-perf-bundle-"));
	try {
		await build({
			root: APP_DIR,
			configFile: join(APP_DIR, "vite.config.ts"),
			logLevel: "warn",
			build: { outDir, emptyOutDir: true, manifest: true },
		});
		const manifest = parseManifest(JSON.parse(await readFile(join(outDir, ".vite/manifest.json"), "utf8")));
		const files = startupFiles(manifest, STARTUP_MODULES);
		const js = await measure(outDir, files.js);
		const css = await measure(outDir, files.css);
		console.log("startup JS chunks (gzip):");
		for (const file of [...js].sort((a, b) => b.gzipBytes - a.gzipBytes)) {
			console.log(`  ${(file.gzipBytes / KB).toFixed(2).padStart(7)} KB  ${file.file}`);
		}
		row("startup JS (gzip)", totalGzip(js) / KB, "KB", BUNDLE_BUDGET.startupJsGzip / KB, atMost);
		row("startup CSS (gzip)", totalGzip(css) / KB, "KB", BUNDLE_BUDGET.startupCssGzip / KB, atMost);
	} finally {
		await rm(outDir, { recursive: true, force: true });
	}
}

// ------------------------------------------------------------- browser

async function runProfile(browser: Browser, baseUrl: string, profile: Profile): Promise<void> {
	const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
	const errors: string[] = [];
	const page: Page = await context.newPage();
	page.on("pageerror", (err) => errors.push(err.message));
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	try {
		await page.goto(`${baseUrl}/perf.html`);
		await page.waitForFunction(() => window.perfHarness !== undefined);
		const { chats } = await page.evaluate(() => {
			const harness = window.perfHarness;
			if (harness === undefined) throw new Error("perf page did not load");
			return harness.ready();
		});
		if (chats < PERF_SEED.chats) throw new Error(`perf: chat list shows ${chats} chats, the seed has ${PERF_SEED.chats}`);
		// Seeding and sync run unthrottled; only the scenarios are throttled.
		const cdp = await context.newCDPSession(page);
		await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpuThrottle });

		const open: OpenSample = await page.evaluate((rounds) => {
			const harness = window.perfHarness;
			if (harness === undefined) throw new Error("perf page did not load");
			return harness.openCachedChats(rounds);
		}, SCENARIO.openRounds);
		const list = await bestOf(SCENARIO.scrollAttempts, () =>
			page.evaluate((step) => {
				const harness = window.perfHarness;
				if (harness === undefined) throw new Error("perf page did not load");
				return harness.scrollChatList(step);
			}, SCENARIO.chatListStepPx),
		);
		const history = await bestOf(SCENARIO.scrollAttempts, () =>
			page.evaluate(
				([messages, step]) => {
					const harness = window.perfHarness;
					if (harness === undefined) throw new Error("perf page did not load");
					return harness.scrollHistory(messages, step);
				},
				[PERF_SEED.scrolledMessages, SCENARIO.historyStepPx] as const,
			),
		);
		if (errors.length > 0) throw new Error(`perf page logged errors:\n  ${errors.join("\n  ")}`);
		report(profile, open, list, history);
	} finally {
		await context.close();
	}
}

/**
 * Runs a scroll scenario `attempts` times and keeps the smoothest run. A
 * single hitch from the shared machine (GC, another process) fails one run;
 * a real regression fails every run.
 */
async function bestOf(attempts: number, run: () => Promise<ScrollSample>): Promise<ScrollSample> {
	let best: ScrollSample | null = null;
	for (let attempt = 0; attempt < attempts; attempt++) {
		const sample = await run();
		if (best === null || smoother(sample, best)) best = sample;
	}
	if (best === null) throw new Error("perf: no scroll attempts");
	return best;
}

function smoother(a: ScrollSample, b: ScrollSample): boolean {
	const x = frameStats(a.frames);
	const y = frameStats(b.frames);
	return x.slowFrames !== y.slowFrames ? x.slowFrames < y.slowFrames : x.averageFps > y.averageFps;
}

function report(profile: Profile, open: OpenSample, list: ScrollSample, history: ScrollSample): void {
	const budget = profile.budget;
	const name = (check: string) => `${profile.name}: ${check}`;
	row(name(`open chat from cache p50 (${open.openMs.length} switches)`), percentile(open.openMs, 50), "ms", budget?.openP50Ms ?? null, atMost);
	row(name("open chat from cache p99"), percentile(open.openMs, 99), "ms", budget?.openP99Ms ?? null, atMost);
	const openTasks = longTaskStats(open.longTasks);
	row(name(`chat switches: long tasks (${openTasks.count}), TBT per switch`), openTasks.totalBlockingMs / Math.max(1, open.openMs.length), "ms", budget?.openTbtPerSwitchMs ?? null, atMost);
	for (const [label, sample] of [
		[`chat list scroll (${list.travelled} chats, best of ${SCENARIO.scrollAttempts})`, list],
		[`history scroll (${history.travelled} messages, best of ${SCENARIO.scrollAttempts})`, history],
	] as const) {
		const frames = frameStats(sample.frames);
		const tasks = longTaskStats(sample.longTasks);
		// One isolated slow frame with no long task in the page is a hitch of the
		// shared CI machine (seen on GitHub runners: one 300 ms frame, 0 ms TBT);
		// it is reported but not gated. Two or more, or any with long tasks, are.
		const gatedSlowFrames = tasks.count === 0 && frames.slowFrames === 1 ? 0 : frames.slowFrames;
		row(name(`${label}: frames over 32 ms (longest ${frames.maxFrameMs.toFixed(0)} ms, raw ${frames.slowFrames})`), gatedSlowFrames, "", budget?.scrollSlowFrames ?? null, atMost);
		row(name(`${label}: average fps`), frames.averageFps, "fps", budget?.scrollMinFps ?? null, atLeast);
		row(name(`${label}: long tasks (${tasks.count}), TBT`), tasks.totalBlockingMs, "ms", budget?.scrollTbtMs ?? null, atMost);
	}
	if (list.travelled < PERF_SEED.chats * 0.99) throw new Error(`perf: chat list scroll travelled ${list.travelled} chats only`);
	if (history.travelled < PERF_SEED.scrolledMessages) throw new Error(`perf: history scroll travelled ${history.travelled} messages only`);
}

async function browserCheck(): Promise<void> {
	await build({ configFile: HARNESS_CONFIG, logLevel: "warn" });
	const server = await preview({ configFile: HARNESS_CONFIG, logLevel: "warn", preview: { port: HARNESS_PORT, strictPort: true } });
	let browser: Browser | null = null;
	try {
		browser = await chromium.launch();
		for (const profile of PROFILES) await runProfile(browser, `http://localhost:${HARNESS_PORT}`, profile);
	} finally {
		await browser?.close();
		await server.close();
	}
}

// ------------------------------------------------------------- report

async function printReport(): Promise<boolean> {
	const status = (pass: boolean | null) => (pass === null ? "info" : pass ? "pass" : "FAIL");
	const width = Math.max(...rows.map((r) => r.check.length));
	console.log("");
	for (const r of rows) console.log(`${status(r.pass).padEnd(5)} ${r.check.padEnd(width)}  ${r.value.padStart(10)}  budget ${r.budget}`);
	const summary = process.env.GITHUB_STEP_SUMMARY;
	if (summary !== undefined && summary !== "") {
		const lines = ["| Check | Value | Budget | Status |", "|---|---|---|---|", ...rows.map((r) => `| ${r.check} | ${r.value} | ${r.budget} | ${status(r.pass)} |`)];
		await appendFile(summary, `## Web perf gate\n\n${lines.join("\n")}\n`);
	}
	return rows.every((r) => r.pass !== false);
}

async function main(): Promise<void> {
	const only = process.argv[2];
	if (only !== undefined && only !== "bundle" && only !== "browser") throw new Error(`usage: perf-gate.ts [bundle|browser], got ${only}`);
	if (only !== "browser") await bundleCheck();
	if (only !== "bundle") await browserCheck();
	const passed = await printReport();
	console.log(passed ? "\nperf gate: all budgets met" : "\nperf gate: budget exceeded");
	process.exitCode = passed ? 0 : 1;
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
	process.exitCode = 1;
});
