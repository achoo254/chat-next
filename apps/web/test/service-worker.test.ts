import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CACHE_PREFIX, cachesToDelete, MAX_UNKNOWN_KEPT, shellRoute } from "../src/sw/shell-routes.ts";
import { appShell, entryScript, SERVICE_WORKER_FILE } from "../vite-service-worker.ts";

const ORIGIN = "https://chat.hoandat.com";
const FILES = new Set(["/index.html", "/manifest.webmanifest", "/icon.svg", "/assets/index-Cl5eqHAX.js"]);

const get = (path: string, mode = "cors") => ({ method: "GET", mode, url: new URL(path, ORIGIN).toString() });

describe("service worker routes", () => {
	it("opens app routes from the network first, with the cached shell offline", () => {
		for (const path of ["/", "/c/42", "/c/42/t/12", "/+invite", "/settings/profile", "/contacts"]) {
			expect(shellRoute(get(path, "navigate"), ORIGIN, FILES), path).toBe("page");
		}
	});

	it("serves the build's files from the cache", () => {
		expect(shellRoute(get("/assets/index-Cl5eqHAX.js"), ORIGIN, FILES)).toBe("file");
		// Chunks the precache missed (a tab of another build) are hashed too.
		expect(shellRoute(get("/assets/older-chunk-abc123.js"), ORIGIN, FILES)).toBe("file");
		expect(shellRoute(get("/manifest.webmanifest"), ORIGIN, FILES)).toBe("file");
		expect(shellRoute(get("/icon.svg"), ORIGIN, FILES)).toBe("file");
	});

	it("never answers the server's endpoints, other origins or writes", () => {
		const server = ["/rpc/app.v1.UsersService/GetSelf", "/ws", "/auth/login", "/auth/callback?code=x", "/hook/abc/secret", "/bot/v1/getMe", "/healthz", "/e2e/realtime"];
		for (const path of server) {
			expect(shellRoute(get(path), ORIGIN, FILES), path).toBe("network");
			// Sign-in and the other server pages are navigations too.
			expect(shellRoute(get(path, "navigate"), ORIGIN, FILES), `${path} (page)`).toBe("network");
		}
		expect(shellRoute(get("https://media-chat.hoandat.com/f/1/photo.jpg"), ORIGIN, FILES)).toBe("network");
		expect(shellRoute({ method: "POST", mode: "cors", url: `${ORIGIN}/assets/index-Cl5eqHAX.js` }, ORIGIN, FILES)).toBe("network");
		// Not part of the build: an unknown root file.
		expect(shellRoute(get("/robots.txt"), ORIGIN, FILES)).toBe("network");
		// Names that only start like a server path are app routes.
		expect(shellRoute(get("/botanist", "navigate"), ORIGIN, FILES)).toBe("page");
	});

	it("deletes only other builds' shell caches that no open tab runs", () => {
		const [a, b, c, current] = [`${CACHE_PREFIX}a`, `${CACHE_PREFIX}b`, `${CACHE_PREFIX}c`, `${CACHE_PREFIX}new`] as const;
		const keys = [a, "media-cache", b, c, current];
		// Every tab answered: only the builds they run stay.
		expect(cachesToDelete(keys, current, new Set([b]), false)).toEqual([a, c]);
		expect(cachesToDelete(keys, current, new Set(), false)).toEqual([a, b, c]);
		expect(cachesToDelete([current, "media-cache"], current, new Set(), false)).toEqual([]);
	});

	it("keeps the newest previous caches while a tab's build is unknown", () => {
		const previous = Array.from({ length: MAX_UNKNOWN_KEPT + 2 }, (_, i) => `${CACHE_PREFIX}${i}`);
		const current = `${CACHE_PREFIX}new`;
		expect(cachesToDelete([...previous, current], current, new Set(), true)).toEqual(previous.slice(0, 2));
		// A cache a known tab needs does not count against the newest kept.
		expect(cachesToDelete([...previous, current], current, new Set([previous[0] ?? ""]), true)).toEqual([previous[1]]);
		expect(cachesToDelete([previous[0] ?? "", current], current, new Set(), true)).toEqual([]);
	});
});

describe("app shell of a build", () => {
	const output = (index: string) =>
		new Map<string, string | Uint8Array>([
			["index.html", `${index}<script type="module" crossorigin src="/assets/index-Cl5eqHAX.js"></script>`],
			["assets/index-Cl5eqHAX.js", "console.log(1)"],
			["assets/index-Cl5eqHAX.js.map", "{}"],
			["assets/inter-vietnamese.woff2", new Uint8Array([1, 2, 3])],
			[".vite/manifest.json", "{}"],
			[SERVICE_WORKER_FILE, "self"],
			["manifest.webmanifest", "{}"],
		]);

	it("lists the files to cache, without the worker, source maps and Vite's manifest", () => {
		expect(appShell(output("<html>")).files).toEqual([
			"/assets/index-Cl5eqHAX.js",
			"/assets/inter-vietnamese.woff2",
			"/index.html",
			"/manifest.webmanifest",
		]);
	});

	it("names the build by the entry script index.html loads", () => {
		expect(appShell(output("<html>")).entry).toBe("/assets/index-Cl5eqHAX.js");
		expect(entryScript('<link rel="modulepreload" href="/assets/x.js">\n  <script type="module" crossorigin src="/assets/index-B1.js"></script>')).toBe("/assets/index-B1.js");
		expect(() => entryScript("<html><body></body></html>")).toThrow(/no module script/);
	});

	it("changes its version with the contents of any file", () => {
		const a = appShell(output("<html>")).version;
		expect(appShell(output("<html>")).version).toBe(a);
		expect(appShell(output("<html lang=vi>")).version).not.toBe(a);
		expect(a).toMatch(/^[0-9a-f]{16}$/);
	});
});

/** A file of the repository as text (vitest runs in apps/web). */
function repoFile(path: string): string {
	return readFileSync(resolve(process.cwd(), "../..", path), "utf8");
}

describe("service worker kill switch (infra/chat/sw-kill-switch.js)", () => {
	type Listener = (event: { waitUntil(promise: Promise<unknown>): void }) => void;

	it("takes over at once, deletes the shell caches, unregisters, and leaves requests to the network", async () => {
		const source = repoFile("infra/chat/sw-kill-switch.js");
		const listeners = new Map<string, Listener>();
		const calls: string[] = [];
		const keys = [`${CACHE_PREFIX}0123456789abcdef`, `${CACHE_PREFIX}fedcba9876543210`, "other-cache"];
		const scope = {
			addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
			skipWaiting: () => calls.push("skipWaiting"),
			registration: { unregister: () => Promise.resolve(calls.push("unregister") > 0) },
		};
		const cacheStorage = {
			keys: () => Promise.resolve(keys),
			delete: (key: string) => Promise.resolve(calls.push(`delete ${key}`) > 0),
		};
		new Function("self", "caches", source)(scope, cacheStorage);
		expect([...listeners.keys()].sort()).toEqual(["activate", "install"]);

		listeners.get("install")?.({ waitUntil: () => undefined });
		const pending: Promise<unknown>[] = [];
		listeners.get("activate")?.({ waitUntil: (promise) => pending.push(promise) });
		await Promise.all(pending);
		expect(calls).toEqual(["skipWaiting", `delete ${keys[0]}`, `delete ${keys[1]}`, "unregister"]);
	});

	it("is served by nginx in place of a missing worker file, never index.html", () => {
		const conf = repoFile("infra/chat/nginx/chat.hoandat.com.conf");
		const location = /location = \/sw\.js \{([^}]*)\}/.exec(conf)?.[1] ?? "";
		expect(location).toContain("try_files /sw-override/sw.js /current/web/sw.js =404;");
		expect(location).toContain('Cache-Control "no-cache"');
		expect(location).not.toContain("index.html");
	});
});
