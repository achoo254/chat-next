// Keeps the service worker's office cache (OFFICE_CACHE, see
// sw/app-shell-worker.ts) in step with the asset list the office tab just
// loaded. Runs in the office tab's lazy chunk, once the list was accepted:
// - drops the cached files the list no longer names (an earlier bake);
// - when the browser is idle, downloads the files this device will want and
//   does not have yet, so the next visit, or a later zone, sound or prop,
//   needs no network.
// Which files a device wants follows what it already loaded: a lightmap
// size, or a 2D picture size, counts once one file of it is cached (the
// scene and the 2D view load their own files first, cache first through the
// worker). A device that only ever drew the 2D view gets no 3D files, and a
// phone never the 2048 lightmaps. Nothing runs without a controlling service
// worker (its cache would never be read) or with Data Saver on.
import { isOfficeFile, OFFICE_CACHE, OFFICE_MANIFEST } from "../../sw/shell-routes.ts";
import { isRecord } from "./office-json.ts";
import { ASSETS_BASE, ASSETS_FORMAT_VERSION, layoutHash } from "./office-assets.ts";

/** Waits this long after the list loaded before the first idle check, so the scene's own downloads go first. */
export const PREFETCH_DELAY_MS = 8_000;
/** The longest wait for an idle moment before a download goes ahead anyway. */
const IDLE_TIMEOUT_MS = 5_000;

/**
 * The office files an asset list names, as absolute paths. Walks the whole
 * list, so it stays right when the list's shape changes: any string naming
 * a hashed office file counts.
 */
export function manifestFiles(json: unknown): Set<string> {
	const out = new Set<string>();
	const walk = (value: unknown): void => {
		if (typeof value === "string") {
			const path = `${ASSETS_BASE}${value}`;
			if (isOfficeFile(path)) out.add(path);
		} else if (Array.isArray(value)) {
			for (const item of value) walk(item);
		} else if (isRecord(value)) {
			for (const item of Object.values(value)) walk(item);
		}
	};
	walk(json);
	return out;
}

export interface AssetKind {
	/** "2d": a picture of the 2D view; "3d": everything the scene loads (models, lightmaps, skins, sounds). */
	readonly view: "2d" | "3d";
	/** The size the file is one of (a lightmap edge or a 2D screen size), null when it has none. */
	readonly variant: string | null;
}

/** What a file is for, from the names the asset pipeline gives (pack-floor.mjs). */
export function assetKind(path: string): AssetKind {
	const name = path.slice(path.lastIndexOf("/") + 1);
	if (name.startsWith("office-2d-")) {
		const screen = /-(phone|desktop)\.[0-9a-f]{8}\.webp$/.exec(name)?.[1];
		return { view: "2d", variant: screen ?? null };
	}
	const lightmap = /^lightmap-.*-(1024|2048)\.[0-9a-f]{8}\.webp$/.exec(name)?.[1];
	return { view: "3d", variant: lightmap ?? null };
}

/**
 * The listed files to download now, in list order: those not cached yet
 * whose view (and size, for sized files) this device has already used,
 * that is, one cached file shares it.
 */
export function filesToPrefetch(listed: ReadonlySet<string>, cached: ReadonlySet<string>): string[] {
	// The list itself says nothing about which view ran.
	const used = [...cached].filter(isOfficeFile).map(assetKind);
	const inUse = (kind: AssetKind): boolean => used.some((u) => u.view === kind.view && (kind.variant === null || u.variant === kind.variant));
	return [...listed].filter((path) => !cached.has(path) && inUse(assetKind(path)));
}

/** The cached office files the list no longer names; the list itself and anything else stay. */
export function entriesToDelete(cached: Iterable<string>, listed: ReadonlySet<string>): string[] {
	return [...cached].filter((path) => isOfficeFile(path) && !listed.has(path));
}

/** Whether a cached list is one this build reads: its format and the layout it was baked from. */
export function listMatchesBuild(json: unknown, hash: string): boolean {
	return isRecord(json) && json.formatVersion === ASSETS_FORMAT_VERSION && json.layoutSha256 === hash;
}

export interface AssetCacheDeps {
	/** null: no Cache Storage (an insecure page, an old browser). */
	readonly caches: CacheStorage | null;
	readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
	/** A service worker controls the page, so the cache is read. */
	readonly controlled: boolean;
	readonly saveData: boolean;
	/** Runs `task` once after `delayMs` at an idle moment; returns a cancel. */
	readonly whenIdle: (task: () => void, delayMs: number) => () => void;
	/** The SHA-256 of the layout this build draws (office-assets.ts layoutHash). */
	readonly layoutHash: () => Promise<string>;
}

interface NetworkInformationLike {
	readonly saveData?: boolean;
}

function browserIdle(task: () => void, delayMs: number): () => void {
	let idle: number | null = null;
	const timer = window.setTimeout(() => {
		if (typeof window.requestIdleCallback === "function") idle = window.requestIdleCallback(task, { timeout: IDLE_TIMEOUT_MS });
		else task();
	}, delayMs);
	return () => {
		window.clearTimeout(timer);
		if (idle !== null) window.cancelIdleCallback(idle);
	};
}

export function browserAssetCacheDeps(): AssetCacheDeps {
	const connection = (navigator as Navigator & { readonly connection?: NetworkInformationLike }).connection;
	return {
		caches: typeof caches === "undefined" ? null : caches,
		fetch: (url, init) => fetch(url, init),
		controlled: navigator.serviceWorker?.controller != null,
		saveData: connection?.saveData === true,
		whenIdle: browserIdle,
		layoutHash: () => layoutHash(),
	};
}

/**
 * Prunes, then fills, the office cache from its cached asset list (stored by
 * the worker when the tab loaded it). Call once the tab accepted the list.
 * Returns a stop: pending downloads are dropped. Failures only cost a later
 * download, so they are logged and never thrown.
 */
export function keepOfficeAssetsCached(deps: AssetCacheDeps = browserAssetCacheDeps()): () => void {
	const store = deps.caches;
	if (store === null || !deps.controlled || deps.saveData) return () => undefined;
	const abort = new AbortController();
	let cancelIdle = deps.whenIdle(() => void run(store).catch(report), PREFETCH_DELAY_MS);
	return () => {
		abort.abort();
		cancelIdle();
	};

	function report(err: unknown): void {
		if (!abort.signal.aborted) console.info("office: keeping the asset cache:", err);
	}

	async function run(caches: CacheStorage): Promise<void> {
		const cache = await caches.open(OFFICE_CACHE);
		const list = await cache.match(OFFICE_MANIFEST);
		if (list === undefined) return;
		const json: unknown = await list.json();
		if (!listMatchesBuild(json, await deps.layoutHash())) return;
		const listed = manifestFiles(json);
		const cached = new Set((await cache.keys()).map((request) => new URL(request.url).pathname));
		await Promise.all(entriesToDelete(cached, listed).map((path) => cache.delete(path)));
		const queue = filesToPrefetch(listed, cached);
		await next(cache, queue);
	}

	/** One download per idle moment, so the tab never competes with itself. */
	async function next(cache: Cache, queue: string[]): Promise<void> {
		const path = queue.shift();
		if (path === undefined || abort.signal.aborted) return;
		const response = await deps.fetch(path, { signal: abort.signal });
		// The worker caches it on the way in; storing here too covers a
		// worker that has not taken this route yet (an older build's).
		if (response.status === 200) await cache.put(path, response);
		if (abort.signal.aborted) return;
		cancelIdle = deps.whenIdle(() => void next(cache, queue).catch(report), 0);
	}
}
