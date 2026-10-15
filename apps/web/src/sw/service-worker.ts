// Service worker of the production web app (built to /sw.js by
// vite-service-worker.ts, registered by register-service-worker.ts). It
// caches only the app shell of its build so the app opens without a network
// and reads the chats from the local database; see shell-routes.ts for what
// it never touches.
//
// Updates: a new build's worker installs (caching its files) and then waits;
// it takes over only when no tab of the previous build is left, and only
// then deletes the previous build's cache, so a running tab never loses the
// files it may still load. Page loads are network first, so a tab opened
// online always gets the newest build whichever worker is active.
import { CACHE_PREFIX, isHashedAsset, SHELL_PAGE, shellRoute, staleCaches } from "./shell-routes.ts";

/** The build's version and files, written in by vite-service-worker.ts. */
declare const __APP_SHELL__: { readonly version: string; readonly files: readonly string[] };

// The DOM typings of the app have no service worker scope; these are the
// parts used here.
interface ExtendableEventLike extends Event {
	waitUntil(promise: Promise<unknown>): void;
}
interface FetchEventLike extends ExtendableEventLike {
	readonly request: Request;
	respondWith(response: Promise<Response>): void;
}
interface ServiceWorkerScope {
	readonly location: { readonly origin: string };
	readonly clients: { claim(): Promise<void> };
	addEventListener(type: "install" | "activate", listener: (event: ExtendableEventLike) => void): void;
	addEventListener(type: "fetch", listener: (event: FetchEventLike) => void): void;
}

const scope = globalThis as unknown as ServiceWorkerScope;
const SHELL = __APP_SHELL__;
const CACHE = CACHE_PREFIX + SHELL.version;
const FILES = new Set(SHELL.files);

scope.addEventListener("install", (event) => {
	// "reload": the files come from the server, not from the HTTP cache.
	const requests = SHELL.files.map((file) => new Request(file, { cache: "reload" }));
	event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(requests)));
});

scope.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			const stale = staleCaches(await caches.keys(), CACHE);
			await Promise.all(stale.map((key) => caches.delete(key)));
			// The first install: control the open tab now, so the files it loads later are served from the cache too.
			await scope.clients.claim();
		})(),
	);
});

scope.addEventListener("fetch", (event) => {
	const route = shellRoute(event.request, scope.location.origin, FILES);
	if (route === "page") event.respondWith(page(event.request));
	else if (route === "file") event.respondWith(file(event.request));
});

async function page(request: Request): Promise<Response> {
	try {
		return await fetch(request);
	} catch (err) {
		const shell = await caches.match(SHELL_PAGE, { cacheName: CACHE });
		if (shell !== undefined) return shell;
		throw err;
	}
}

async function file(request: Request): Promise<Response> {
	// Any build's cache: a tab of the previous build may still load its chunks.
	const cached = await caches.match(request);
	if (cached !== undefined) return cached;
	const response = await fetch(request);
	if (response.ok && response.type === "basic" && isHashedAsset(new URL(request.url).pathname)) {
		const copy = response.clone();
		await caches
			.open(CACHE)
			.then((cache) => cache.put(request, copy))
			.catch(() => undefined);
	}
	return response;
}
