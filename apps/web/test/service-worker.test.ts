import { describe, expect, it } from "vitest";
import { CACHE_PREFIX, shellRoute, staleCaches } from "../src/sw/shell-routes.ts";
import { appShell, SERVICE_WORKER_FILE } from "../vite-service-worker.ts";

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

	it("deletes only other builds' shell caches", () => {
		const current = `${CACHE_PREFIX}new`;
		expect(staleCaches([`${CACHE_PREFIX}old`, current, "media-cache", `${CACHE_PREFIX}older`], current)).toEqual([`${CACHE_PREFIX}old`, `${CACHE_PREFIX}older`]);
	});
});

describe("app shell of a build", () => {
	const output = (index: string) =>
		new Map<string, string | Uint8Array>([
			["index.html", index],
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

	it("changes its version with the contents of any file", () => {
		const a = appShell(output("<html>")).version;
		expect(appShell(output("<html>")).version).toBe(a);
		expect(appShell(output("<html lang=vi>")).version).not.toBe(a);
		expect(a).toMatch(/^[0-9a-f]{16}$/);
	});
});
