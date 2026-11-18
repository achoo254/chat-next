// The office tab's side of the office asset cache: which files an asset list
// names, which of them a device wants ahead of time, which cached entries an
// earlier bake left behind, and the idle-time prune and fill run against an
// in-memory cache and network.
import { describe, expect, it, vi } from "vitest";
import {
	assetKind,
	entriesToDelete,
	filesToPrefetch,
	keepOfficeAssetsCached,
	listMatchesBuild,
	manifestFiles,
	PREFETCH_DELAY_MS,
	type AssetCacheDeps,
} from "../../src/machines/office/office-asset-cache.ts";
import { ASSETS_FORMAT_VERSION } from "../../src/machines/office/office-assets.ts";
import { OFFICE_CACHE, OFFICE_MANIFEST } from "../../src/sw/shell-routes.ts";

const ORIGIN = "https://chat.hoandat.com";
const HASH = "a".repeat(64);

const SHELL = "/office/office-zone-a.11111111.glb";
const PROPS = "/office/office-props-zone-a.22222222.glb";
const CHARACTER = "/office/character.33333333.glb";
const SKINS = "/office/character-skins.44444444.webp";
const SOUND = "/office/sfx/typing.55555555.mp3";
const DAY_1024 = "/office/lightmap-zone-a-day-1024.66666666.webp";
const NIGHT_1024 = "/office/lightmap-zone-a-night-1024.77777777.webp";
const DAY_2048 = "/office/lightmap-zone-a-day-2048.88888888.webp";
const PLAN_PHONE_DAY = "/office/office-2d-plan-day-phone.99999999.webp";
const PLAN_PHONE_NIGHT = "/office/office-2d-plan-night-phone.aaaaaaaa.webp";
const PLAN_DESKTOP_DAY = "/office/office-2d-plan-day-desktop.bbbbbbbb.webp";

const name = (path: string): string => path.slice("/office/".length);

/** An asset list in the shape the pipeline writes; only the names matter here. */
function list(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		formatVersion: ASSETS_FORMAT_VERSION,
		bakeSha256: HASH,
		note: "made by tools/office-art; names carry a content hash",
		zones: [
			{
				id: "a",
				scene: {
					shell: name(SHELL),
					props: name(PROPS),
					lightmaps: { day: { 1024: name(DAY_1024), 2048: name(DAY_2048) }, night: { 1024: name(NIGHT_1024) } },
					models: ["desk", "chair"],
				},
			},
		],
		views: { phone: { day: name(PLAN_PHONE_DAY), night: name(PLAN_PHONE_NIGHT) }, desktop: { day: name(PLAN_DESKTOP_DAY) } },
		character: { file: name(CHARACTER), clips: ["Idle_A"], skins: { file: name(SKINS), columns: 2, rows: 2, count: 4, names: [] } },
		sfx: { sounds: { typing: { file: name(SOUND), loop: true, seconds: 1.6 } } },
		...overrides,
	};
}

const ALL = [SHELL, PROPS, DAY_1024, DAY_2048, NIGHT_1024, PLAN_PHONE_DAY, PLAN_PHONE_NIGHT, PLAN_DESKTOP_DAY, CHARACTER, SKINS, SOUND];

describe("office asset list", () => {
	it("names every hashed file it mentions, wherever the list puts it", () => {
		expect([...manifestFiles(list())].sort()).toEqual([...ALL].sort());
	});

	it("ignores names that are not hashed office files", () => {
		const odd = list({ extra: ["../secret.11111111.glb", "plain.glb", "x.11111111.exe", "/office/abs.11111111.glb", 42, null] });
		expect(manifestFiles(odd).size).toBe(ALL.length);
		expect(manifestFiles(null).size).toBe(0);
		expect(manifestFiles("character.33333333.glb")).toEqual(new Set([CHARACTER]));
	});

	it("is one this build reads only with its format version and layout", () => {
		expect(listMatchesBuild(list(), HASH)).toBe(true);
		expect(listMatchesBuild(list({ formatVersion: ASSETS_FORMAT_VERSION + 1 }), HASH)).toBe(false);
		expect(listMatchesBuild(list(), "b".repeat(64))).toBe(false);
		expect(listMatchesBuild([], HASH)).toBe(false);
	});
});

describe("which office files to fetch ahead", () => {
	it("knows a file's view and size from its name", () => {
		expect(assetKind(DAY_2048)).toEqual({ view: "3d", variant: "2048" });
		expect(assetKind(SOUND)).toEqual({ view: "3d", variant: null });
		expect(assetKind(PLAN_PHONE_NIGHT)).toEqual({ view: "2d", variant: "phone" });
		expect(assetKind("/office/office-2d-floor-1-day-desktop.f0890371.webp")).toEqual({ view: "2d", variant: "desktop" });
	});

	it("fills in the 3D files of the lightmap size in use, sounds included, never the other size", () => {
		const cached = new Set([SHELL, DAY_1024]);
		expect(filesToPrefetch(manifestFiles(list()), cached).sort()).toEqual([PROPS, NIGHT_1024, CHARACTER, SKINS, SOUND].sort());
	});

	it("fills in the 2D pictures of the screen size in use only once the 2D view drew one", () => {
		const cached = new Set([PLAN_PHONE_DAY]);
		expect(filesToPrefetch(manifestFiles(list()), cached)).toEqual([PLAN_PHONE_NIGHT]);
		const both = new Set([SHELL, DAY_2048, PLAN_DESKTOP_DAY]);
		const wanted = filesToPrefetch(manifestFiles(list()), both);
		expect(wanted).toContain(SOUND);
		expect(wanted).not.toContain(DAY_1024);
		expect(wanted).not.toContain(PLAN_PHONE_DAY);
	});

	it("fetches nothing ahead for a device that has loaded nothing yet", () => {
		expect(filesToPrefetch(manifestFiles(list()), new Set())).toEqual([]);
		expect(filesToPrefetch(manifestFiles(list()), new Set([OFFICE_MANIFEST]))).toEqual([]);
	});

	it("drops the cached files an earlier bake left, keeping the list itself", () => {
		const old = "/office/office-floor-1.5f2a8edb.glb";
		const oldSound = "/office/sfx/elevator-ding.745bd5a2.mp3";
		expect(entriesToDelete([OFFICE_MANIFEST, SHELL, old, oldSound, SOUND], manifestFiles(list()))).toEqual([old, oldSound]);
	});
});

/** A Cache in memory keyed by pathname, holding the body text. */
class MemoryCache {
	readonly entries = new Map<string, string>();
	failPuts = false;
	private readonly path = (request: RequestInfo | URL): string => new URL(request instanceof Request ? request.url : request.toString(), ORIGIN).pathname;

	match(request: RequestInfo | URL): Promise<Response | undefined> {
		const body = this.entries.get(this.path(request));
		return Promise.resolve(body === undefined ? undefined : new Response(body));
	}
	async put(request: RequestInfo | URL, response: Response): Promise<void> {
		if (this.failPuts) throw new DOMException("quota", "QuotaExceededError");
		this.entries.set(this.path(request), await response.text());
	}
	delete(request: RequestInfo | URL): Promise<boolean> {
		return Promise.resolve(this.entries.delete(this.path(request)));
	}
	keys(): Promise<Request[]> {
		return Promise.resolve([...this.entries.keys()].map((path) => new Request(new URL(path, ORIGIN))));
	}
}

interface Run {
	readonly cache: MemoryCache;
	readonly fetched: string[];
	readonly delays: number[];
	/** Runs the idle tasks queued so far, and those they queue, to the end. */
	idle(): Promise<void>;
	deps: AssetCacheDeps;
}

function setup(entries: Record<string, string>, over: Partial<AssetCacheDeps> = {}): Run {
	const cache = new MemoryCache();
	for (const [path, body] of Object.entries(entries)) cache.entries.set(path, body);
	const fetched: string[] = [];
	const delays: number[] = [];
	let tasks: (() => void)[] = [];
	const deps: AssetCacheDeps = {
		caches: { open: (key: string) => Promise.resolve((key === OFFICE_CACHE ? cache : new MemoryCache()) as unknown as Cache) } as unknown as CacheStorage,
		fetch: (url) => {
			fetched.push(url);
			return Promise.resolve(new Response(`network ${url}`));
		},
		controlled: true,
		saveData: false,
		whenIdle: (task, delayMs) => {
			delays.push(delayMs);
			tasks.push(task);
			return () => {
				tasks = tasks.filter((t) => t !== task);
			};
		},
		bakeHash: () => Promise.resolve(HASH),
		...over,
	};
	return {
		cache,
		fetched,
		delays,
		deps,
		async idle() {
			// A task queues the next one only after its downloads and cache
			// writes settle: done once a few turns pass with nothing queued.
			let quiet = 0;
			for (let turn = 0; turn < 500 && quiet < 5; turn++) {
				const now = tasks;
				tasks = [];
				for (const task of now) task();
				quiet = now.length === 0 ? quiet + 1 : 0;
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		},
	};
}

describe("keeping the office cache", () => {
	const listed = JSON.stringify(list());

	it("waits for an idle moment, drops an earlier bake's files and fetches what is missing, one by one", async () => {
		const old = "/office/office-floor-1.5f2a8edb.glb";
		const run = setup({ [OFFICE_MANIFEST]: listed, [SHELL]: "shell", [DAY_1024]: "day", [old]: "old" });
		keepOfficeAssetsCached(run.deps);
		expect(run.delays).toEqual([PREFETCH_DELAY_MS]);
		expect(run.fetched).toEqual([]);
		await run.idle();
		expect(run.cache.entries.has(old)).toBe(false);
		expect(run.fetched.sort()).toEqual([PROPS, NIGHT_1024, CHARACTER, SKINS, SOUND].sort());
		for (const path of run.fetched) expect(run.cache.entries.get(path)).toBe(`network ${path}`);
		expect(run.cache.entries.get(SHELL)).toBe("shell");
		expect(run.cache.entries.has(DAY_2048)).toBe(false);
	});

	it("touches nothing when the cached list is for another layout or format", async () => {
		const old = "/office/office-floor-1.5f2a8edb.glb";
		for (const other of [list({ bakeSha256: "c".repeat(64) }), list({ formatVersion: 99 })]) {
			const run = setup({ [OFFICE_MANIFEST]: JSON.stringify(other), [SHELL]: "shell", [old]: "old" });
			keepOfficeAssetsCached(run.deps);
			await run.idle();
			expect(run.cache.entries.has(old)).toBe(true);
			expect(run.fetched).toEqual([]);
		}
	});

	it("does nothing without a cached list, a controlling worker, Cache Storage, or with Data Saver on", async () => {
		const empty = setup({ [SHELL]: "shell" });
		keepOfficeAssetsCached(empty.deps);
		await empty.idle();
		expect(empty.fetched).toEqual([]);
		for (const over of [{ controlled: false }, { saveData: true }, { caches: null }]) {
			const run = setup({ [OFFICE_MANIFEST]: listed, [SHELL]: "shell" }, over);
			keepOfficeAssetsCached(run.deps);
			expect(run.delays).toEqual([]);
		}
	});

	it("stops fetching once stopped", async () => {
		const run = setup({ [OFFICE_MANIFEST]: listed, [SHELL]: "shell", [DAY_1024]: "day" });
		const stop = keepOfficeAssetsCached(run.deps);
		stop();
		await run.idle();
		expect(run.fetched).toEqual([]);
	});

	it("gives up quietly when the cache is out of quota or the network fails", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const full = setup({ [OFFICE_MANIFEST]: listed, [SHELL]: "shell", [DAY_1024]: "day" });
		full.cache.failPuts = true;
		keepOfficeAssetsCached(full.deps);
		await full.idle();
		expect(full.fetched).toHaveLength(1);

		const offline = setup({ [OFFICE_MANIFEST]: listed, [SHELL]: "shell", [DAY_1024]: "day" }, { fetch: () => Promise.reject(new TypeError("offline")) });
		keepOfficeAssetsCached(offline.deps);
		await offline.idle();
		expect(offline.cache.entries.size).toBe(3);
		expect(info).toHaveBeenCalledTimes(2);
		info.mockRestore();
	});

	it("does not store error answers", async () => {
		const run = setup({ [OFFICE_MANIFEST]: listed, [SHELL]: "shell", [DAY_1024]: "day" }, { fetch: () => Promise.resolve(new Response("gone", { status: 404 })) });
		keepOfficeAssetsCached(run.deps);
		await run.idle();
		expect(run.cache.entries.size).toBe(3);
	});
});
