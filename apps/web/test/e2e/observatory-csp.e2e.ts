// The Live Map's PixiJS renderer under the production Content Security
// Policy. Dev server, vitest and the perf gate send no CSP, so nothing else
// would notice PixiJS generating code with `new Function` (no 'unsafe-eval'
// in script-src) or starting a worker from a blob: URL (worker-src 'self').
// The app is built for production with one extra page
// (observatory-csp-harness.html, which mounts the renderer on the shipped
// assets and plays real events through the reducer) and served by a small
// server that sends the CSP header read, at run time, from
// infra/chat/nginx/chat.hoandat.com.conf. No backend is needed.
//
// Checks: with WebGL, no CSP violation and no console error, the renderer is
// WebGL, the canvas shows more than one colour, the events play (the
// animation log names them) and the scene goes still afterwards; with WebGL
// switched off, the Canvas renderer or the still view, still without a CSP
// violation.
//
//   node --test apps/web/test/e2e/observatory-csp.e2e.ts    (on its own)
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { build } from "vite";

const APP_DIR = fileURLToPath(new URL("../../", import.meta.url));
const NGINX_CONF = fileURLToPath(new URL("../../../../infra/chat/nginx/chat.hoandat.com.conf", import.meta.url));
const HARNESS = "test/e2e/observatory-csp-harness.html";
/** Not one of the e2e stack's ports (run.ts) nor sw-update's. */
const PORT = 4711;
const ORIGIN = `http://localhost:${PORT}`;
const WAIT_MS = 30_000;

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript",
	".css": "text/css",
	".json": "application/json",
	".webp": "image/webp",
	".png": "image/png",
	".svg": "image/svg+xml",
	".woff2": "font/woff2",
	".wasm": "application/wasm",
	".webmanifest": "application/manifest+json",
};

/** The CSP the site sends, exactly as nginx sends it; every location sends the same one. */
async function productionCsp(): Promise<string> {
	const conf = await readFile(NGINX_CONF, "utf8");
	const all = [...conf.matchAll(/add_header Content-Security-Policy "([^"]+)"/g)].map((m) => m[1] ?? "");
	assert.ok(all.length > 0, "nginx conf has a Content-Security-Policy");
	assert.equal(new Set(all).size, 1, "every location sends the same CSP");
	const csp = all[0] ?? "";
	assert.doesNotMatch(csp, /'unsafe-eval'/, "the production CSP has no 'unsafe-eval'");
	assert.match(csp, /worker-src 'self'(;|$)/, "workers only from the site itself");
	return csp;
}

let dir = "";
let csp = "";
let server: Server | null = null;
let browser: Browser | null = null;

async function file(path: string): Promise<string | null> {
	const full = normalize(join(dir, decodeURIComponent(path)));
	if (!full.startsWith(dir)) return null;
	try {
		return (await stat(full)).isFile() ? full : null;
	} catch {
		return null;
	}
}

before(async () => {
	csp = await productionCsp();
	dir = await mkdtemp(join(tmpdir(), "chat-observatory-csp-"));
	await build({
		root: APP_DIR,
		configFile: join(APP_DIR, "vite.config.ts"),
		logLevel: "warn",
		build: { outDir: dir, emptyOutDir: true, rollupOptions: { input: { index: join(APP_DIR, "index.html"), harness: join(APP_DIR, HARNESS) } } },
	});
	server = createServer((req, res) => {
		const path = new URL(req.url ?? "/", ORIGIN).pathname;
		void file(path).then((found) => {
			if (found === null) {
				res.writeHead(404, { "Content-Security-Policy": csp }).end();
				return;
			}
			res.writeHead(200, { "Content-Type": TYPES[extname(found)] ?? "application/octet-stream", "Content-Security-Policy": csp, "Cache-Control": "no-cache" });
			createReadStream(found).pipe(res);
		});
	});
	const listening = server;
	await new Promise<void>((resolve) => listening.listen(PORT, "127.0.0.1", resolve));
});

after(async () => {
	await browser?.close();
	const open = server;
	if (open !== null) await new Promise<void>((resolve) => open.close(() => resolve()));
	if (dir !== "") await rm(dir, { recursive: true, force: true });
});

interface Run {
	readonly page: Page;
	readonly violations: string[];
	readonly errors: string[];
}

async function open(args: string[]): Promise<Run> {
	await browser?.close();
	browser = await chromium.launch({ args });
	const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
	const violations: string[] = [];
	const errors: string[] = [];
	await page.exposeFunction("__reportCsp", (line: string) => violations.push(line));
	// Runs before the page's own scripts (through the browser's debugging protocol, not subject to the CSP).
	await page.addInitScript(() => {
		document.addEventListener("securitypolicyviolation", (e) => {
			const report = (window as unknown as { __reportCsp: (line: string) => void }).__reportCsp;
			report(`${e.effectiveDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`);
		});
	});
	page.on("console", (msg) => {
		if (msg.type() === "error") errors.push(msg.text());
	});
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(`${ORIGIN}/${HARNESS}`);
	await page.waitForFunction(() => document.body.dataset.status !== undefined, null, { timeout: WAIT_MS });
	return { page, violations, errors };
}

/** Distinct colours in a screenshot of the scene, counted in the page from the PNG bytes (no network). */
async function colours(page: Page): Promise<number> {
	const png = (await page.locator("#host").screenshot()).toString("base64");
	return page.evaluate(async (b64) => {
		const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
		const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
		const canvas = document.createElement("canvas");
		canvas.width = bitmap.width;
		canvas.height = bitmap.height;
		const ctx = canvas.getContext("2d");
		if (ctx === null) return 0;
		ctx.drawImage(bitmap, 0, 0);
		const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
		const seen = new Set<number>();
		for (let i = 0; i < data.length && seen.size < 1_000; i += 4 * 97) seen.add(((data[i] ?? 0) << 16) | ((data[i + 1] ?? 0) << 8) | (data[i + 2] ?? 0));
		return seen.size;
	}, png);
}

test("draws with WebGL under the production CSP and goes still after its events", async () => {
	const { page, violations, errors } = await open(["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]);
	const status = await page.evaluate(() => [document.body.dataset.status, document.body.dataset.error ?? ""]);
	assert.deepEqual(status, ["ready", ""], `the scene started: ${status[1]}`);
	assert.equal(await page.evaluate(() => window.__liveMapHarness?.renderer), "webgl");
	const played = await page.evaluate(() => window.__liveMapHarness?.play() ?? 0);
	assert.ok(played >= 3, `animations queued: ${played}`);
	await page.waitForTimeout(400);
	assert.ok((await colours(page)) > 20, "the canvas shows the plate and its pieces");
	// Every move ends within 1.5 s; the core stopped (a Stop came), so nothing moves after.
	await page.waitForTimeout(2_000);
	const settled = await page.evaluate(() => window.__liveMapHarness?.frames() ?? -1);
	await page.waitForTimeout(2_000);
	assert.equal(await page.evaluate(() => window.__liveMapHarness?.frames() ?? -1), settled, "no frame while idle");
	const logged = await page.evaluate(() => (window.__liveMapHarness?.log() ?? []).map((e) => e.eventId));
	for (const id of ["prompt:p1", "tool:t1", "event:stop"]) assert.ok(logged.includes(id), `${id} played`);
	assert.deepEqual(violations, [], "no CSP violation");
	assert.deepEqual(errors, [], "no console error");
});

test("with WebGL switched off, falls back to Canvas or the still view, still within the CSP", async (t) => {
	const { page, violations } = await open(["--disable-webgl", "--disable-3d-apis"]);
	const status = await page.evaluate(() => document.body.dataset.status);
	t.diagnostic(`without WebGL: ${status === "ready" ? `renderer ${await page.evaluate(() => window.__liveMapHarness?.renderer)}` : `still view (${await page.evaluate(() => document.body.dataset.error ?? "")})`}`);
	if (status === "ready") {
		assert.equal(await page.evaluate(() => window.__liveMapHarness?.renderer), "canvas");
		await page.evaluate(() => window.__liveMapHarness?.play());
		await page.waitForTimeout(400);
		assert.ok((await colours(page)) > 20, "the Canvas renderer draws the plate");
	} else assert.equal(status, "still");
	assert.deepEqual(violations, [], "no CSP violation");
});
