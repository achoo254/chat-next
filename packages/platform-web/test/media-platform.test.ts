// Web media platform: blob stores on the Cache API (one per database name,
// destroyed in one call) and fetch-based HTTP without cookies.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheBlobStores, fetchHttp } from "../src/media-platform.ts";

/** The part of CacheStorage the store uses, kept in memory. */
class MemoryCacheStorage {
	readonly caches = new Map<string, Map<string, Response>>();

	async open(name: string): Promise<Cache> {
		let entries = this.caches.get(name);
		if (entries === undefined) {
			entries = new Map();
			this.caches.set(name, entries);
		}
		const map = entries;
		const cache = {
			match: async (request: string) => map.get(request)?.clone(),
			put: async (request: string, response: Response) => {
				map.set(request, response);
			},
			delete: async (request: string) => map.delete(request),
		};
		return cache as unknown as Cache;
	}

	async delete(name: string): Promise<boolean> {
		return this.caches.delete(name);
	}
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Cache API blob store", () => {
	it("stores blobs with their type per (tenant, user) and destroys them on sign-out", async () => {
		const storage = new MemoryCacheStorage();
		const factory = cacheBlobStores(storage as unknown as CacheStorage);
		if (factory === undefined) throw new Error("no factory");
		const store = await factory.open("chat.example.test-7");
		await store.put("upload:1", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
		const blob = await store.get("upload:1");
		expect(blob?.type).toBe("image/png");
		expect([...new Uint8Array((await blob?.arrayBuffer()) ?? new ArrayBuffer(0))]).toEqual([1, 2, 3]);
		expect(await store.get("missing")).toBeNull();
		await store.delete("upload:1");
		expect(await store.get("upload:1")).toBeNull();
		await store.put("cache:a", new Blob(["x"]));
		expect([...storage.caches.keys()]).toEqual(["media:chat.example.test-7"]);
		await store.destroy();
		expect(storage.caches.size).toBe(0);
	});

	it("is unavailable without the Cache API", () => {
		expect(cacheBlobStores(undefined)).toBeUndefined();
	});
});

describe("fetch HTTP", () => {
	it("PUTs parts without cookies and reads the ETag; GETs bodies only on success", async () => {
		const calls: { url: string; init: RequestInit | undefined }[] = [];
		vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
			calls.push({ url, init });
			if (init?.method === "PUT") return new Response(null, { status: 200, headers: { ETag: '"abc"' } });
			if (url.endsWith("/gone")) return new Response("no", { status: 404 });
			return new Response(new Blob([new Uint8Array([9])]), { status: 200 });
		});
		expect(await fetchHttp.put("https://s3.test/p/1", new Blob(["x"]))).toEqual({ status: 200, etag: '"abc"' });
		expect(calls[0]?.init).toMatchObject({ method: "PUT", credentials: "omit" });
		const got = await fetchHttp.get("https://media.test/f/t");
		expect(got.status).toBe(200);
		expect(got.body?.size).toBe(1);
		expect(await fetchHttp.get("https://media.test/gone")).toEqual({ status: 404, body: null });
		expect(calls[1]?.init).toMatchObject({ credentials: "omit" });
	});
});
