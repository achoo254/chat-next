// The app shell's service worker (entry: service-worker.ts). It caches only
// the app shell of its build so the app opens without a network and reads
// the chats from the local database; see shell-routes.ts for what it never
// touches. The worker scope, CacheStorage and fetch are passed in, so the
// tests can run it against fakes.
//
// - Page loads are network first: a tab opened online always gets the
//   newest build, whichever worker is active. The cached shell of this
//   build opens the app offline.
// - The build's files (hashed, under /assets/) are cache first, from this
//   build's cache, then any kept build's.
// - Updates: a new build's worker caches its files and takes over at once
//   (skipWaiting, clients.claim), also from a worker still waiting for the
//   last tab to close. It keeps the caches of the previous builds that open
//   tabs still run, since nginx serves only the current release's files and
//   those tabs load lazy chunks of their own build. Tabs then show the
//   "Đã có bản mới" bar (register-service-worker.ts); nothing reloads them.
// - The Live Map's hashed assets live in their own cache (OBSERVATORY_CACHE),
//   kept across builds: cache first, cached on the way in. Its asset list is
//   network first, so a new bake is seen at once, with the cached copy
//   offline; a newly fetched list drops the cached files it no longer names.
//   The 3D office's cache (RETIRED_CACHES) is deleted on activate.
import { answerBuild, askBuild, isBuildQuery, type MessageTarget } from "./build-messages.ts";
import {
	CACHE_PREFIX,
	cachesToDelete,
	isHashedAsset,
	OBSERVATORY_CACHE,
	observatoryEntriesToDelete,
	RETIRED_CACHES,
	SHELL_PAGE,
	shellRoute,
} from "./shell-routes.ts";

export interface AppShellBuild {
	readonly version: string;
	/** Absolute paths of the cached files. */
	readonly files: readonly string[];
	/** The build's entry script ("/assets/index-<hash>.js"), its name in build messages. */
	readonly entry: string;
}

// The DOM typings of the app have no service worker scope; these are the
// parts used here.
export interface ExtendableEventLike {
	waitUntil(promise: Promise<unknown>): void;
}
export interface FetchEventLike extends ExtendableEventLike {
	readonly request: Request;
	respondWith(response: Promise<Response>): void;
}
export interface MessageEventLike extends ExtendableEventLike {
	readonly data: unknown;
	readonly ports: readonly MessagePort[];
}
export interface WindowClientLike extends MessageTarget {
	readonly id: string;
}
export interface ServiceWorkerScopeLike {
	readonly location: { readonly origin: string };
	readonly clients: {
		claim(): Promise<void>;
		matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<readonly WindowClientLike[]>;
	};
	skipWaiting(): Promise<void>;
	addEventListener(type: "install" | "activate", listener: (event: ExtendableEventLike) => void): void;
	addEventListener(type: "fetch", listener: (event: FetchEventLike) => void): void;
	addEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
}

export interface WorkerDeps {
	readonly caches: CacheStorage;
	readonly fetch: (request: Request) => Promise<Response>;
	/** How long to wait for a tab's answer (build-messages.ts default). */
	readonly replyTimeoutMs?: number;
}

export function startAppShellWorker(scope: ServiceWorkerScopeLike, build: AppShellBuild, deps: WorkerDeps): void {
	const { caches, fetch } = deps;
	const cacheName = CACHE_PREFIX + build.version;
	const files = new Set(build.files);

	scope.addEventListener("install", (event) => {
		// "reload": the files come from the server, not from the HTTP cache.
		const requests = build.files.map((file) => new Request(new URL(file, scope.location.origin), { cache: "reload" }));
		// Take over once the files are cached, without waiting for the
		// previous build's tabs to close: they keep their files (prune).
		event.waitUntil(
			caches
				.open(cacheName)
				.then((cache) => cache.addAll(requests))
				.then(() => scope.skipWaiting()),
		);
	});

	scope.addEventListener("activate", (event) => {
		// Control the open tabs now, so the files they load later come from the caches.
		// Pruning waits for a tab's build question: activation holds back every fetch.
		// The retired caches have no reader left, so they go now; a failure only leaves them for the next activation.
		event.waitUntil(Promise.all([scope.clients.claim(), dropRetiredCaches()]));
	});

	scope.addEventListener("fetch", (event) => {
		const route = shellRoute(event.request, scope.location.origin, files);
		if (route === "page") event.respondWith(page(event.request));
		else if (route === "file") event.respondWith(file(event.request));
		else if (route === "observatory-file") event.respondWith(observatoryFile(event));
		else if (route === "observatory-manifest") event.respondWith(observatoryManifest(event));
	});

	scope.addEventListener("message", (event) => {
		if (!isBuildQuery(event.data)) return;
		answerBuild(event.ports[0], build.entry);
		event.waitUntil(prune().catch((err: unknown) => console.warn("service worker: pruning caches:", err)));
	});

	async function page(request: Request): Promise<Response> {
		try {
			return await fetch(request);
		} catch (err) {
			const shell = await caches.match(SHELL_PAGE, { cacheName });
			if (shell !== undefined) return shell;
			throw err;
		}
	}

	async function file(request: Request): Promise<Response> {
		// This build's copy first (the manifest and icons keep their names
		// across builds), then a kept build's: a tab of that build loads its chunks.
		const cached = (await caches.match(request, { cacheName })) ?? (await caches.match(request));
		if (cached !== undefined) return cached;
		const response = await fetch(request);
		if (response.ok && response.type === "basic" && isHashedAsset(new URL(request.url).pathname)) {
			const copy = response.clone();
			await caches
				.open(cacheName)
				.then((cache) => cache.put(request, copy))
				// Not caching a copy only costs a download next time.
				.catch(() => undefined);
		}
		return response;
	}

	async function observatoryFile(event: FetchEventLike): Promise<Response> {
		const { request } = event;
		const cached = await caches.match(request, { cacheName: OBSERVATORY_CACHE });
		if (cached !== undefined) return cached;
		const response = await fetch(request);
		// Stored in the background: the page reads the file while it streams in.
		if (keepable(response)) event.waitUntil(storeObservatory(request, response.clone()));
		return response;
	}

	async function observatoryManifest(event: FetchEventLike): Promise<Response> {
		const { request } = event;
		let response: Response;
		try {
			response = await fetch(request);
		} catch (err) {
			const cached = await caches.match(request, { cacheName: OBSERVATORY_CACHE });
			if (cached !== undefined) return cached;
			throw err;
		}
		if (keepable(response)) {
			// Stored before answering, so an offline open reads the list the page saw; the earlier bake's files go in the background.
			await storeObservatory(request, response.clone());
			event.waitUntil(pruneObservatory(response.clone()));
		}
		return response;
	}

	/** Only whole same-origin answers are worth keeping (no errors, no 206 parts). */
	function keepable(response: Response): boolean {
		return response.status === 200 && response.type === "basic";
	}

	async function storeObservatory(request: Request, response: Response): Promise<void> {
		try {
			const cache = await caches.open(OBSERVATORY_CACHE);
			await cache.put(request, response);
		} catch {
			// Out of quota or storage gone: not caching only costs a download next time.
		}
	}

	/** Deletes the cached Live Map files the fresh asset list no longer names. */
	async function pruneObservatory(list: Response): Promise<void> {
		try {
			const json: unknown = await list.json();
			const cache = await caches.open(OBSERVATORY_CACHE);
			const cached = (await cache.keys()).map((key) => new URL(key.url).pathname);
			await Promise.all(observatoryEntriesToDelete(cached, json).map((path) => cache.delete(path)));
		} catch (err) {
			// A list that does not parse, or storage gone: the files stay until the next list.
			console.warn("service worker: pruning the Live Map cache:", err);
		}
	}

	async function dropRetiredCaches(): Promise<void> {
		try {
			await Promise.all(RETIRED_CACHES.map((key) => caches.delete(key)));
		} catch (err) {
			console.warn("service worker: deleting retired caches:", err);
		}
	}

	/** Deletes the previous builds' caches that no open tab runs. */
	async function prune(): Promise<void> {
		const keys = (await caches.keys()).filter((key) => key.startsWith(CACHE_PREFIX));
		if (keys.every((key) => key === cacheName)) return;
		const tabs = await scope.clients.matchAll({ type: "window", includeUncontrolled: true });
		const entries = await Promise.all(tabs.map((tab) => askBuild(tab, deps.replyTimeoutMs)));
		const needed = new Set<string>();
		for (const entry of entries) {
			if (entry === null || files.has(entry)) continue;
			const holder = await newestCacheWith(keys, entry);
			if (holder !== null) needed.add(holder);
		}
		const stale = cachesToDelete(keys, cacheName, needed, entries.includes(null));
		await Promise.all(stale.map((key) => caches.delete(key)));
	}

	async function newestCacheWith(keys: readonly string[], path: string): Promise<string | null> {
		for (const key of [...keys].reverse()) {
			const cache = await caches.open(key);
			if ((await cache.match(path)) !== undefined) return key;
		}
		return null;
	}
}
