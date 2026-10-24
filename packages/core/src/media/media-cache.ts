// Local media cache (Phase 5): downloaded files in the platform BlobStore,
// bookkeeping in the local database. Bounded three ways: total bytes, a
// separate budget for large files and video, and age since last use; past a
// bound the least recently used files go first. Every cached file
// remembers the messages it was fetched for (media_cache_refs); triggers on
// messages drop those when a message is purged or recalled, and a file left
// without messages is evicted, so deleted or hidden media do not linger.
import type { BlobStore } from "@achoo254/chat-platform";
import { num, str } from "../repo/rows.ts";
import { placeholders } from "../repo/writes.ts";
import type { MediaSizeType } from "../model/types.ts";
import type { UploadDb } from "./upload-queue.ts";

export interface CacheLimits {
	/** Every cached file together. */
	readonly sizeBytes: number;
	/** Large files and video, inside sizeBytes. */
	readonly largeBytes: number;
	/** Files unused for longer are evicted. */
	readonly maxAgeMs: number;
}

/** A file this large (or any video) counts against the large-file budget. */
export const LARGE_FILE_BYTES = 10 << 20;

export interface MediaCacheOptions {
	readonly db: UploadDb;
	readonly store: BlobStore;
	readonly now: () => number;
	readonly limits: () => CacheLimits;
	readonly onError?: (error: unknown, context: string) => void;
}

/** Cache key of a file rendition. */
export function cacheKey(fileId: string, size: MediaSizeType): string {
	return `${fileId}:${size}`;
}

function blobKey(key: string): string {
	return `cache:${key}`;
}

export class MediaCache {
	private evicting: Promise<void> | null = null;
	private evictAgain = false;

	constructor(private readonly options: MediaCacheOptions) {}

	/** The cached file, marked as just used; null on a miss. */
	async get(key: string): Promise<Blob | null> {
		const rows = await this.options.db.query("SELECT key FROM media_cache WHERE key = ?", [key]);
		if (rows.length === 0) return null;
		const blob = await this.options.store.get(blobKey(key));
		if (blob === null) {
			// The browser evicted the storage: forget the row too.
			await this.options.db.commit((w) => {
				w.add("DELETE FROM media_cache WHERE key = ?", [key]);
				w.add("DELETE FROM media_cache_refs WHERE key = ?", [key]);
			});
			return null;
		}
		await this.options.db.commit((w) => {
			w.add("UPDATE media_cache SET last_access = ? WHERE key = ?", [this.options.now(), key]);
		});
		return blob;
	}

	/** Records that `key` is shown for message (chatId, seq). */
	async addRef(key: string, chatId: number, seq: number): Promise<void> {
		await this.options.db.commit((w) => {
			w.add("INSERT OR IGNORE INTO media_cache_refs (key, chat_id, seq) VALUES (?, ?, ?)", [key, chatId, seq]);
		});
	}

	/**
	 * Caches a file fetched for message (chatId, seq). A file larger than its
	 * budget is not kept; returns whether it was.
	 */
	async put(key: string, blob: Blob, chatId: number, seq: number, large: boolean): Promise<boolean> {
		const limits = this.options.limits();
		if (blob.size > (large ? Math.min(limits.largeBytes, limits.sizeBytes) : limits.sizeBytes)) return false;
		await this.options.store.put(blobKey(key), blob);
		const now = this.options.now();
		await this.options.db.commit((w) => {
			w.add(
				`INSERT INTO media_cache (key, bytes, large, last_access, created_at) VALUES (?, ?, ?, ?, ?)
				ON CONFLICT (key) DO UPDATE SET bytes = excluded.bytes, large = excluded.large, last_access = excluded.last_access`,
				[key, blob.size, large ? 1 : 0, now, now],
			);
			w.add("INSERT OR IGNORE INTO media_cache_refs (key, chat_id, seq) VALUES (?, ?, ?)", [key, chatId, seq]);
		});
		await this.evict();
		return true;
	}

	/** Forgets the message's files (it was deleted, recalled or became unreachable). */
	async dropMessage(chatId: number, seq: number): Promise<void> {
		await this.options.db.commit((w) => {
			w.add("DELETE FROM media_cache_refs WHERE chat_id = ? AND seq = ?", [chatId, seq]);
		});
		await this.evict();
	}

	/** Total bytes cached, for settings screens. */
	async usage(): Promise<{ readonly bytes: number; readonly largeBytes: number; readonly files: number }> {
		const rows = await this.options.db.query(
			"SELECT COALESCE(sum(bytes), 0) AS bytes, COALESCE(sum(CASE WHEN large = 1 THEN bytes ELSE 0 END), 0) AS large, count(*) AS n FROM media_cache",
		);
		const row = rows[0] ?? {};
		return { bytes: num(row, "bytes"), largeBytes: num(row, "large"), files: num(row, "n") };
	}

	/** Deletes every cached file. */
	async clear(): Promise<void> {
		const rows = await this.options.db.query("SELECT key FROM media_cache");
		await this.remove(rows.map((row) => str(row, "key")));
	}

	/**
	 * Evicts files without messages, files unused past the age limit, then
	 * the least recently used beyond the large-file and total budgets.
	 * Concurrent calls share one pass (plus one more if asked meanwhile).
	 */
	async evict(): Promise<void> {
		if (this.evicting !== null) {
			this.evictAgain = true;
			return this.evicting;
		}
		this.evicting = (async () => {
			try {
				do {
					this.evictAgain = false;
					await this.evictOnce();
				} while (this.evictAgain);
			} finally {
				this.evicting = null;
			}
		})();
		return this.evicting;
	}

	private async evictOnce(): Promise<void> {
		const limits = this.options.limits();
		const doomed = new Set<string>();
		const orphans = await this.options.db.query(
			"SELECT key FROM media_cache c WHERE NOT EXISTS (SELECT 1 FROM media_cache_refs r WHERE r.key = c.key)",
		);
		for (const row of orphans) doomed.add(str(row, "key"));
		const old = await this.options.db.query("SELECT key FROM media_cache WHERE last_access < ?", [
			this.options.now() - limits.maxAgeMs,
		]);
		for (const row of old) doomed.add(str(row, "key"));
		const all = await this.options.db.query("SELECT key, bytes, large FROM media_cache ORDER BY last_access DESC, key");
		let total = 0;
		let large = 0;
		for (const row of all) {
			const key = str(row, "key");
			if (doomed.has(key)) continue;
			const bytes = num(row, "bytes");
			if (num(row, "large") !== 0) {
				if (large + bytes > limits.largeBytes) {
					doomed.add(key);
					continue;
				}
				large += bytes;
			}
			if (total + bytes > limits.sizeBytes) {
				doomed.add(key);
				continue;
			}
			total += bytes;
		}
		await this.remove([...doomed]);
	}

	private async remove(keys: readonly string[]): Promise<void> {
		if (keys.length === 0) return;
		for (let i = 0; i < keys.length; i += 500) {
			const chunk = keys.slice(i, i + 500);
			await this.options.db.commit((w) => {
				w.add(`DELETE FROM media_cache WHERE key IN (${placeholders(chunk.length)})`, chunk);
				w.add(`DELETE FROM media_cache_refs WHERE key IN (${placeholders(chunk.length)})`, chunk);
			});
		}
		for (const key of keys) {
			try {
				await this.options.store.delete(blobKey(key));
			} catch (err) {
				this.options.onError?.(err, `media cache delete ${key}`);
			}
		}
	}
}
