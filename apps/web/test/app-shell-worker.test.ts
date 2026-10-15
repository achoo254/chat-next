// The app shell's service worker (src/sw/app-shell-worker.ts) run against an
// in-memory CacheStorage, a fake network and fake tabs.
import { describe, expect, it } from "vitest";
import {
	startAppShellWorker,
	type AppShellBuild,
	type ExtendableEventLike,
	type FetchEventLike,
	type MessageEventLike,
	type ServiceWorkerScopeLike,
	type WindowClientLike,
} from "../src/sw/app-shell-worker.ts";
import { askBuild, BUILD_QUERY, BUILD_REPLY } from "../src/sw/build-messages.ts";
import { CACHE_PREFIX } from "../src/sw/shell-routes.ts";

const ORIGIN = "https://chat.hoandat.com";
const url = (path: string) => new URL(path, ORIGIN).toString();

/** CacheStorage in memory; keys() keeps the creation order, as browsers do. */
class MemoryCaches {
	readonly stores = new Map<string, Map<string, string>>();

	open(name: string): Promise<Cache> {
		let store = this.stores.get(name);
		if (store === undefined) {
			store = new Map();
			this.stores.set(name, store);
		}
		const entries = store;
		const key = (request: RequestInfo | URL) => new URL(request instanceof Request ? request.url : request.toString(), ORIGIN).pathname;
		const cache = {
			match: (request: RequestInfo | URL) => {
				const body = entries.get(key(request));
				return Promise.resolve(body === undefined ? undefined : new Response(body));
			},
			put: async (request: RequestInfo | URL, response: Response) => {
				entries.set(key(request), await response.text());
			},
			addAll: async (requests: RequestInfo[]) => {
				for (const request of requests) entries.set(key(request), `network ${key(request)}`);
			},
		};
		return Promise.resolve(cache as unknown as Cache);
	}

	async match(request: RequestInfo | URL, options?: MultiCacheQueryOptions): Promise<Response | undefined> {
		const names = options?.cacheName === undefined ? [...this.stores.keys()] : [options.cacheName].filter((name) => this.stores.has(name));
		for (const name of names) {
			const found = await (await this.open(name)).match(request);
			if (found !== undefined) return found;
		}
		return undefined;
	}

	keys(): Promise<string[]> {
		return Promise.resolve([...this.stores.keys()]);
	}

	delete(name: string): Promise<boolean> {
		return Promise.resolve(this.stores.delete(name));
	}

	asStorage(): CacheStorage {
		return this as unknown as CacheStorage;
	}
}

/** A tab that answers build questions with its entry, or never (entry null). */
function tab(id: string, entry: string | null): WindowClientLike {
	return {
		id,
		postMessage: (message, transfer) => {
			const port = transfer[0] as MessagePort | undefined;
			if (entry === null || port === undefined) return;
			expect(message).toEqual({ type: BUILD_QUERY });
			port.postMessage({ type: BUILD_REPLY, entry });
			port.close();
		},
	};
}

function build(version: string, entry: string): AppShellBuild {
	return { version, entry, files: ["/index.html", "/manifest.webmanifest", entry, `/assets/lazy-${version}.js`] };
}

interface Harness {
	readonly caches: MemoryCaches;
	readonly calls: string[];
	readonly tabs: WindowClientLike[];
	online: boolean;
	install(): Promise<void>;
	activate(): Promise<void>;
	request(path: string, mode?: string): Promise<Response | null>;
	ask(): Promise<string | null>;
}

function startWorker(shell: AppShellBuild, caches = new MemoryCaches()): Harness {
	const listeners = new Map<string, (event: never) => void>();
	const calls: string[] = [];
	const tabs: WindowClientLike[] = [];
	const scope: ServiceWorkerScopeLike = {
		location: { origin: ORIGIN },
		clients: {
			claim: () => Promise.resolve(void calls.push("claim")),
			matchAll: () => Promise.resolve(tabs),
		},
		skipWaiting: () => Promise.resolve(void calls.push("skipWaiting")),
		addEventListener: (type: string, listener: (event: never) => void) => listeners.set(type, listener),
	};
	const harness: Harness = {
		caches,
		calls,
		tabs,
		online: true,
		async install() {
			await dispatchExtendable("install");
		},
		async activate() {
			await dispatchExtendable("activate");
		},
		async request(path, mode = "cors") {
			let response: Promise<Response> | null = null;
			const event: FetchEventLike = {
				request: new Request(url(path), mode === "navigate" ? {} : { mode: mode as RequestMode }),
				respondWith: (promise) => {
					response = promise;
				},
				waitUntil: () => undefined,
			};
			// navigate cannot be set on a Request built outside a browser.
			if (mode === "navigate") Object.defineProperty(event.request, "mode", { value: "navigate" });
			(listeners.get("fetch") as (event: FetchEventLike) => void)(event);
			return response;
		},
		async ask() {
			const pending: Promise<unknown>[] = [];
			const worker = {
				postMessage: (data: unknown, transfer: Transferable[]) => {
					const event: MessageEventLike = { data, ports: transfer as MessagePort[], waitUntil: (p) => pending.push(p) };
					(listeners.get("message") as (event: MessageEventLike) => void)(event);
				},
			};
			const entry = await askBuild(worker);
			await Promise.all(pending);
			return entry;
		},
	};
	startAppShellWorker(scope, shell, {
		caches: caches.asStorage(),
		fetch: (request) => {
			calls.push(`fetch ${new URL(request.url).pathname}`);
			if (!harness.online) return Promise.reject(new TypeError("offline"));
			const response = new Response(`network ${new URL(request.url).pathname}`);
			// A same-origin answer, as the browser's fetch gives it.
			Object.defineProperty(response, "type", { value: "basic" });
			return Promise.resolve(response);
		},
		replyTimeoutMs: 50,
	});
	return harness;

	async function dispatchExtendable(type: string): Promise<void> {
		const pending: Promise<unknown>[] = [];
		const event: ExtendableEventLike = { waitUntil: (promise) => pending.push(promise) };
		(listeners.get(type) as (event: ExtendableEventLike) => void)(event);
		await Promise.all(pending);
	}
}

const OLD = build("old", "/assets/index-OLD.js");
const NEW = build("new", "/assets/index-NEW.js");

describe("app shell worker: updates", () => {
	it("caches its build and takes over at once, without waiting for the old tabs", async () => {
		const worker = startWorker(NEW);
		await worker.install();
		expect(worker.calls).toEqual(["skipWaiting"]);
		expect([...(worker.caches.stores.get(`${CACHE_PREFIX}new`)?.keys() ?? [])]).toEqual(NEW.files);
		await worker.activate();
		expect(worker.calls).toEqual(["skipWaiting", "claim"]);
	});

	it("keeps the previous build's cache on takeover, so an old tab still loads its lazy chunks", async () => {
		const old = startWorker(OLD);
		await old.install();
		const worker = startWorker(NEW, old.caches);
		await worker.install();
		await worker.activate();
		expect([...worker.caches.stores.keys()]).toEqual([`${CACHE_PREFIX}old`, `${CACHE_PREFIX}new`]);
		worker.online = false;
		const chunk = await worker.request("/assets/lazy-old.js");
		expect(await chunk?.text()).toBe("network /assets/lazy-old.js");
		expect(worker.calls).not.toContain("fetch /assets/lazy-old.js");
	});

	it("answers which build it runs, and then drops the caches no open tab runs", async () => {
		const caches = new MemoryCaches();
		await startWorker(build("older", "/assets/index-OLDER.js"), caches).install();
		await startWorker(OLD, caches).install();
		const worker = startWorker(NEW, caches);
		await worker.install();
		await worker.activate();
		worker.tabs.push(tab("a", OLD.entry), tab("b", NEW.entry));
		expect(await worker.ask()).toBe(NEW.entry);
		expect([...caches.stores.keys()]).toEqual([`${CACHE_PREFIX}old`, `${CACHE_PREFIX}new`]);

		// The old tab reloaded into the new build.
		worker.tabs.splice(0, 1);
		await worker.ask();
		expect([...caches.stores.keys()]).toEqual([`${CACHE_PREFIX}new`]);
	});

	it("keeps previous caches while a tab does not say which build it runs", async () => {
		const caches = new MemoryCaches();
		await startWorker(OLD, caches).install();
		const worker = startWorker(NEW, caches);
		await worker.install();
		worker.tabs.push(tab("silent", null));
		await worker.ask();
		expect([...caches.stores.keys()]).toEqual([`${CACHE_PREFIX}old`, `${CACHE_PREFIX}new`]);
	});
});

describe("app shell worker: requests", () => {
	it("loads pages from the network, and the cached shell of its build offline", async () => {
		const caches = new MemoryCaches();
		await startWorker(OLD, caches).install();
		const worker = startWorker(NEW, caches);
		await worker.install();
		const online = await worker.request("/c/42", "navigate");
		expect(await online?.text()).toBe("network /c/42");
		worker.online = false;
		const offline = await worker.request("/c/42", "navigate");
		// This build's index.html, never a kept build's.
		expect(await offline?.text()).toBe("network /index.html");
		expect(caches.stores.get(`${CACHE_PREFIX}new`)?.has("/index.html")).toBe(true);
	});

	it("serves files of its own build before a kept build's copy", async () => {
		const caches = new MemoryCaches();
		const old = startWorker(OLD, caches);
		await old.install();
		await caches.open(`${CACHE_PREFIX}old`).then((cache) => cache.put("/manifest.webmanifest", new Response("old manifest")));
		const worker = startWorker(NEW, caches);
		await worker.install();
		expect(await (await worker.request("/manifest.webmanifest"))?.text()).toBe("network /manifest.webmanifest");
	});

	it("caches a hashed file it did not have, and leaves the server's endpoints alone", async () => {
		const worker = startWorker(NEW);
		await worker.install();
		const response = await worker.request("/assets/chunk-from-a-newer-tab.js");
		expect(await response?.text()).toBe("network /assets/chunk-from-a-newer-tab.js");
		expect(worker.caches.stores.get(`${CACHE_PREFIX}new`)?.get("/assets/chunk-from-a-newer-tab.js")).toBe("network /assets/chunk-from-a-newer-tab.js");
		expect(await worker.request("/rpc/app.v1.UsersService/GetSelf")).toBeNull();
		expect(await worker.request("/auth/login", "navigate")).toBeNull();
	});
});
