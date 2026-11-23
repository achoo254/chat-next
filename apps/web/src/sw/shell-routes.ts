// Which requests the service worker answers (service-worker.ts). Only the
// app shell (page loads of the app's own routes and the build's files) and
// the Live Map's hashed assets with their asset list (public/observatory/). The
// server's endpoints (Connect RPC, realtime, sign-in, webhooks, Bot API,
// health) and every other origin (the media host) always go to the network
// untouched, so no API answer or user file ever lands in the cache.

/** Prefix of the shell caches; one cache per build (CACHE_PREFIX + version). */
export const CACHE_PREFIX = "app-shell-";

/** The cached page every app route opens offline. */
export const SHELL_PAGE = "/index.html";

/** Served by the server, never by the cache (exact path or path + "/..."). */
const SERVER_PATHS = ["/rpc", "/ws", "/auth", "/hook", "/bot", "/healthz", "/e2e"] as const;

/**
 * The Live Map's assets (public/observatory/), kept across builds: their
 * names carry a content hash, so a cached copy never goes stale. Not under
 * CACHE_PREFIX, so pruning the builds' caches leaves it alone; the worker
 * drops the entries a newly fetched asset list no longer names
 * (observatoryEntriesToDelete). Renaming it drops the whole cache.
 */
export const OBSERVATORY_CACHE = "observatory-assets-v1";

/** The cache of the 3D office the Live Map replaced; the worker deletes it on activate. */
export const RETIRED_CACHES = ["office-assets-v1"] as const;

/** Where the Live Map's assets are served from. */
const OBSERVATORY_BASE = "/observatory/";

/** The Live Map's asset list: the one file there without a hash in its name. */
export const OBSERVATORY_MANIFEST = `${OBSERVATORY_BASE}observatory-assets.json`;

/** "/observatory/<name>.<8 hex>.<webp|json>": the plates, the scene table, the sprite sheets. */
const OBSERVATORY_FILE = /^\/observatory\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.[0-9a-f]{8}\.(?:webp|json)$/;

/** A content-hashed Live Map asset (a pathname, no query). */
export function isObservatoryFile(pathname: string): boolean {
	return OBSERVATORY_FILE.test(pathname);
}

/**
 * The hashed files an asset list names, as absolute paths. Walks the whole
 * list, so it stays right when the list's shape changes: any string naming a
 * hashed Live Map file counts.
 */
export function observatoryListFiles(list: unknown): Set<string> {
	const out = new Set<string>();
	const walk = (value: unknown): void => {
		if (typeof value === "string") {
			const path = OBSERVATORY_BASE + value;
			if (isObservatoryFile(path)) out.add(path);
		} else if (Array.isArray(value)) {
			for (const item of value) walk(item);
		} else if (typeof value === "object" && value !== null) {
			for (const item of Object.values(value)) walk(item);
		}
	};
	walk(list);
	return out;
}

/**
 * The cached Live Map files (pathnames) a new asset list no longer names: an
 * earlier bake's. The list names every file the scene loads (plates, scene
 * table, each atlas's sheet and image). The list itself, and anything not a
 * hashed file, stays; a list naming no hashed file at all deletes nothing,
 * so a broken list never empties the cache.
 */
export function observatoryEntriesToDelete(cached: Iterable<string>, list: unknown): string[] {
	const listed = observatoryListFiles(list);
	if (listed.size === 0) return [];
	return [...cached].filter((path) => isObservatoryFile(path) && !listed.has(path));
}

export type ShellRoute =
	/** A page load of an app route: network first, the cached shell offline. */
	| "page"
	/** A file of the build: cache first. */
	| "file"
	/** A hashed Live Map asset: cache first from OBSERVATORY_CACHE, cached on the way in. */
	| "observatory-file"
	/** The Live Map's asset list: network first, its cached copy offline. */
	| "observatory-manifest"
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
	// A query would make another cache entry for the same file: left to the network.
	if (url.search === "" && url.pathname === OBSERVATORY_MANIFEST) return "observatory-manifest";
	if (url.search === "" && isObservatoryFile(url.pathname)) return "observatory-file";
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
