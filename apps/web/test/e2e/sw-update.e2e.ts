// A deploy while tabs are open, on production builds with the service
// worker (src/sw): the dev server of the other scenarios has none. Two
// builds of the app (the second with changed code, so new file names) are
// served by a small server that follows the nginx rules
// (infra/chat/nginx/chat.hoandat.com.conf): /assets/ only from the current
// release, /sw.js and pages no-cache, app routes fall back to index.html.
// No backend is needed; the app shows its start screen.
//
// Checks: the open tab shows "Đã có bản mới · Tải lại" and keeps loading its
// own build's lazy chunks after the server dropped them; a tab opened after
// the deploy shows no bar; "Tải lại" loads the new build and the old
// build's cache goes; with the server gone the app still opens from the
// cache.
//
//   pnpm e2e sw-update                                (with the e2e stack)
//   node --test apps/web/test/e2e/sw-update.e2e.ts    (on its own)
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { build, type Plugin } from "vite";

const APP_DIR = fileURLToPath(new URL("../../", import.meta.url));
/** Not one of the e2e stack's ports (run.ts), so both can run together. */
const PORT = 4710;
const ORIGIN = `http://localhost:${PORT}`;
const WAIT_MS = 30_000;

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript",
	".css": "text/css",
	".json": "application/json",
	".webmanifest": "application/manifest+json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".wasm": "application/wasm",
};
const SERVER_PATHS = /^\/(rpc|ws|auth|hook|bot|healthz|e2e)(\/|$)/;

interface Release {
	readonly dir: string;
	readonly entry: string;
	/** The signed-in app's lazy chunk ("/assets/messaging-root-<hash>.js"). */
	readonly lazyChunk: string;
}

/** Changed code for the "new" build: its entry and lazy chunk get new names. */
const nextBuild: Plugin = {
	name: "e2e-next-build",
	enforce: "post",
	transform(code, id) {
		if (/\/src\/(main|messaging\/messaging-root)\.tsx$/.test(id)) return `${code}\n;globalThis.__e2eBuild = "next";\n`;
		return undefined;
	},
};

async function buildRelease(name: string, plugins: Plugin[]): Promise<Release> {
	const dir = await mkdtemp(join(tmpdir(), `chat-sw-${name}-`));
	await build({ root: APP_DIR, configFile: join(APP_DIR, "vite.config.ts"), logLevel: "warn", plugins, build: { outDir: dir, emptyOutDir: true, manifest: true } });
	const manifest = JSON.parse(await readFile(join(dir, ".vite/manifest.json"), "utf8")) as Record<string, { file: string }>;
	const index = await readFile(join(dir, "index.html"), "utf8");
	const entry = /<script type="module"[^>]*src="([^"]+)"/.exec(index)?.[1];
	const lazy = manifest["src/messaging/messaging-root.tsx"]?.file;
	assert.ok(entry !== undefined && lazy !== undefined, `${name}: entry and lazy chunk`);
	return { dir, entry, lazyChunk: `/${lazy}` };
}

/** The current release, served like nginx serves /opt/chat/current/web. */
let current: Release;
let server: Server;

async function file(path: string): Promise<string | null> {
	const full = normalize(join(current.dir, path));
	if (!full.startsWith(current.dir)) return null;
	return (await stat(full).catch(() => null))?.isFile() === true ? full : null;
}

function startServer(): Promise<void> {
	server = createServer((req, res) => {
		const path = decodeURIComponent(new URL(req.url ?? "/", ORIGIN).pathname);
		const send = (full: string | null, cacheControl: string): void => {
			if (full === null) {
				res.writeHead(404).end();
				return;
			}
			res.writeHead(200, { "Content-Type": TYPES[extname(full)] ?? "application/octet-stream", "Cache-Control": cacheControl });
			createReadStream(full).pipe(res);
		};
		void (async () => {
			if (SERVER_PATHS.test(path)) return send(null, "");
			if (path.startsWith("/assets/")) return send(await file(path), "public, max-age=31536000, immutable");
			if (path === "/sw.js") return send(await file(path), "no-cache");
			send((await file(path)) ?? join(current.dir, "index.html"), "no-cache");
		})().catch(() => res.writeHead(500).end());
	});
	return new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
}

function stopServer(): Promise<void> {
	server.closeAllConnections();
	return new Promise((resolve) => server.close(() => resolve()));
}

const entryOf = (page: Page): Promise<string | null> => page.evaluate(() => document.querySelector('script[type="module"][src]')?.getAttribute("src") ?? null);
const updateBar = (page: Page) => page.getByRole("status").filter({ hasText: "Đã có bản mới" });
const shellCaches = (page: Page): Promise<string[]> => page.evaluate(async () => (await caches.keys()).filter((key) => key.startsWith("app-shell-")));

/** Opens the app and waits until the service worker controls the tab. */
async function open(context: BrowserContext): Promise<Page> {
	const page = await context.newPage();
	await page.goto(`${ORIGIN}/`);
	await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: WAIT_MS });
	return page;
}

async function poll<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
	const until = Date.now() + WAIT_MS;
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (Date.now() > until) assert.fail(`${what}: still ${JSON.stringify(value)}`);
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
}

let old: Release;
let next: Release;
let browser: Browser;

before(async () => {
	// One build at a time (shared 16 GB machine).
	old = await buildRelease("old", []);
	next = await buildRelease("next", [nextBuild]);
	assert.notEqual(old.entry, next.entry);
	assert.notEqual(old.lazyChunk, next.lazyChunk);
	current = old;
	await startServer();
	browser = await chromium.launch();
});

after(async () => {
	await browser?.close();
	if (server?.listening) await stopServer();
	await Promise.all([old, next].filter(Boolean).map((release) => rm(release.dir, { recursive: true, force: true })));
});

test("a deploy reaches open tabs without breaking them, and the app still opens offline", async () => {
	const context = await browser.newContext({ locale: "vi-VN", viewport: { width: 1280, height: 800 } });
	const oldTab = await open(context);
	assert.equal(await entryOf(oldTab), old.entry);

	// Deploy. A tab opened now gets the new build from the network; its load
	// checks /sw.js, and the new worker takes over every tab at once.
	current = next;
	const newTab = await open(context);
	assert.equal(await entryOf(newTab), next.entry);
	await updateBar(oldTab).waitFor({ timeout: WAIT_MS });
	assert.equal(await updateBar(oldTab).textContent(), "Đã có bản mới·Tải lại");
	assert.equal(await updateBar(newTab).count(), 0, "a tab of the new build shows no bar");
	assert.equal(await oldTab.evaluate(() => (globalThis as { __e2eBuild?: string }).__e2eBuild ?? "old"), "old", "no automatic reload");

	// The server no longer has the old build's lazy chunk; the old tab still loads it.
	assert.equal((await fetch(ORIGIN + old.lazyChunk)).status, 404);
	const chunk = await oldTab.evaluate(async (path) => {
		const response = await fetch(path);
		return { status: response.status, size: (await response.text()).length };
	}, old.lazyChunk);
	assert.equal(chunk.status, 200);
	assert.ok(chunk.size > 1000, `lazy chunk served from the cache (${chunk.size} bytes)`);
	assert.equal((await shellCaches(oldTab)).length, 2, "the old build's cache stays while its tab is open");

	// "Tải lại" loads the new build; no tab runs the old one any more, so its cache goes.
	await Promise.all([oldTab.waitForEvent("load"), updateBar(oldTab).getByRole("button", { name: "Tải lại" }).click()]);
	assert.equal(await entryOf(oldTab), next.entry);
	assert.equal(await updateBar(oldTab).count(), 0);
	await poll("shell caches after the reload", () => shellCaches(oldTab), (keys) => keys.length === 1);

	// The server is gone: page loads come from the cached shell of the new build.
	await stopServer();
	await oldTab.reload();
	assert.equal(await entryOf(oldTab), next.entry);
	await oldTab.locator("#root").waitFor({ state: "attached" });
	await oldTab.waitForFunction(() => (globalThis as { __e2eBuild?: string }).__e2eBuild === "next", undefined, { timeout: WAIT_MS });
	await context.close();
});
