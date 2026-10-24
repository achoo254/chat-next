// Media pieces of the web platform, used inside the worker:
// - Http: fetch without cookies (presigned upload URLs and signed media
//   URLs carry their own credentials);
// - BlobStore on the Cache API: one cache per (tenant, user) database name,
//   holding pending upload files (resume after reload) and the media cache.
//   The Cache API is available in workers, stores large Blobs on disk
//   without loading them into memory, and is deleted in one call on
//   sign-out;
// - ImageProbe: createImageBitmap + OffscreenCanvas, so photos are measured
//   and thumbnailed off the main thread.
import type { BlobStore, BlobStoreFactory, Http, ImageInfo, ImageProbe } from "@achoo254/chat-platform";

export const fetchHttp: Http = {
	async put(url, body, signal) {
		const response = await fetch(url, { method: "PUT", body, credentials: "omit", ...(signal === undefined ? {} : { signal }) });
		// The body of a storage answer is not needed; drop it to free the connection.
		await response.body?.cancel();
		return { status: response.status, etag: response.headers.get("ETag") ?? "" };
	},
	async get(url, signal) {
		const response = await fetch(url, { credentials: "omit", ...(signal === undefined ? {} : { signal }) });
		if (!response.ok) {
			await response.body?.cancel();
			return { status: response.status, body: null };
		}
		return { status: response.status, body: await response.blob() };
	},
};

/** Synthetic request URL of a key; never fetched. */
function requestFor(key: string): string {
	return `https://blob.invalid/${encodeURIComponent(key)}`;
}

class CacheBlobStore implements BlobStore {
	constructor(
		private readonly storage: CacheStorage,
		private readonly name: string,
	) {}

	async get(key: string): Promise<Blob | null> {
		const cache = await this.storage.open(this.name);
		const response = await cache.match(requestFor(key));
		if (response === undefined) return null;
		const blob = await response.blob();
		const type = response.headers.get("Content-Type") ?? "";
		return type === "" || blob.type === type ? blob : new Blob([blob], { type });
	}

	async put(key: string, blob: Blob): Promise<void> {
		const cache = await this.storage.open(this.name);
		const headers: Record<string, string> = blob.type === "" ? {} : { "Content-Type": blob.type };
		await cache.put(requestFor(key), new Response(blob, { headers }));
	}

	async delete(key: string): Promise<void> {
		const cache = await this.storage.open(this.name);
		await cache.delete(requestFor(key));
	}

	async destroy(): Promise<void> {
		await this.storage.delete(this.name);
	}
}

/** Blob stores on the Cache API; undefined where it is missing (insecure context). */
export function cacheBlobStores(storage: CacheStorage | undefined = globalThis.caches): BlobStoreFactory | undefined {
	if (storage === undefined) return undefined;
	return { open: async (name) => new CacheBlobStore(storage, `media:${name}`) };
}

/** Longest side of the inline thumbnail. */
const THUMB_SIDE = 40;
const THUMB_MAX_BYTES = 2048;

export const canvasImageProbe: ImageProbe = {
	async probe(blob): Promise<ImageInfo | null> {
		if (typeof createImageBitmap !== "function") return null;
		let bitmap: ImageBitmap;
		try {
			bitmap = await createImageBitmap(blob);
		} catch {
			return null;
		}
		try {
			const { width, height } = bitmap;
			let thumb: Uint8Array | null = null;
			if (typeof OffscreenCanvas === "function" && width > 0 && height > 0) {
				const scale = Math.min(1, THUMB_SIDE / Math.max(width, height));
				const canvas = new OffscreenCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
				const context = canvas.getContext("2d");
				if (context !== null) {
					context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
					for (const quality of [0.6, 0.3]) {
						const out = new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality })).arrayBuffer());
						if (out.length <= THUMB_MAX_BYTES) {
							thumb = out;
							break;
						}
					}
				}
			}
			return { width, height, thumb };
		} finally {
			bitmap.close();
		}
	},
};
