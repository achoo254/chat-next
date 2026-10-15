// Which requests the service worker answers (service-worker.ts). Only the
// app shell: page loads of the app's own routes and the build's files. The
// server's endpoints (Connect RPC, realtime, sign-in, webhooks, Bot API,
// health) and every other origin (the media host) always go to the network
// untouched, so no API answer or user file ever lands in the cache.

/** Prefix of the shell caches; one cache per build (CACHE_PREFIX + version). */
export const CACHE_PREFIX = "app-shell-";

/** The cached page every app route opens offline. */
export const SHELL_PAGE = "/index.html";

/** Served by the server, never by the cache (exact path or path + "/..."). */
const SERVER_PATHS = ["/rpc", "/ws", "/auth", "/hook", "/bot", "/healthz", "/e2e"] as const;

export type ShellRoute =
	/** A page load of an app route: network first, the cached shell offline. */
	| "page"
	/** A file of the build: cache first. */
	| "file"
	/** Not the shell's business: the browser handles it as without a worker. */
	| "network";

export interface RequestInfo {
	readonly method: string;
	readonly mode: string;
	readonly url: string;
}

function serverPath(pathname: string): boolean {
	return SERVER_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/** Content-hashed build output under /assets/: never changes, safe to keep. */
export function isHashedAsset(pathname: string): boolean {
	return pathname.startsWith("/assets/");
}

/** shellFiles: the build's files as absolute paths ("/index.html", "/assets/…", "/manifest.webmanifest"). */
export function shellRoute(request: RequestInfo, origin: string, shellFiles: ReadonlySet<string>): ShellRoute {
	if (request.method !== "GET") return "network";
	let url: URL;
	try {
		url = new URL(request.url);
	} catch {
		return "network";
	}
	if (url.origin !== origin || serverPath(url.pathname)) return "network";
	if (request.mode === "navigate") return "page";
	if (isHashedAsset(url.pathname) || shellFiles.has(url.pathname)) return "file";
	return "network";
}

/**
 * Previous builds' shell caches kept for tabs whose build is unknown (a tab
 * that does not answer: a build older than the build query, or a frozen
 * background tab). Each holds one build (about 3.5 MB).
 */
export const MAX_UNKNOWN_KEPT = 3;

/**
 * The shell caches to delete. A tab keeps running the build it loaded, and
 * nginx serves only the current release's files, so the cache of every
 * build a tab still runs must stay until that tab is gone: otherwise its
 * next lazy chunk fails to load.
 *
 * keys: every cache name, oldest first (the order of caches.keys()).
 * current: this worker's cache. neededByTabs: caches of builds that open
 * tabs said they run. unknownTabs: some tab did not say; then the newest
 * MAX_UNKNOWN_KEPT other previous caches stay too.
 */
export function cachesToDelete(keys: readonly string[], current: string, neededByTabs: ReadonlySet<string>, unknownTabs: boolean): string[] {
	const previous = keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== current && !neededByTabs.has(key));
	const kept = unknownTabs ? MAX_UNKNOWN_KEPT : 0;
	return previous.slice(0, Math.max(0, previous.length - kept));
}
