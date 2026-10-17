// Media model mapping and local storage, the media cache (budgets, LRU,
// age, purge with messages) and download URLs (batching, refresh on 403,
// revocation on 404).
import { describe, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";
import type { SqlDriver } from "@app/platform";
import { MediaKind, MediaRefSchema, MediaSizeType } from "@app/proto-ts/media";
import { MessageSchema } from "@app/proto-ts/messages";
import { EventBus } from "../src/events/bus.ts";
import { cacheKey, MediaCache, type CacheLimits } from "../src/media/media-cache.ts";
import { MediaLoader, URLS_PER_CALL } from "../src/media/media-loader.ts";
import { uploadPhotoNow } from "../src/media/direct-upload.ts";
import { UserSchema } from "@app/proto-ts/users";
import { toMessage, toUser } from "../src/protocol/map.ts";
import { purgeMessages, recallMessages } from "../src/purge/index.ts";
import { migrate } from "../src/repo/migrations.ts";
import { Repository } from "../src/repo/repository.ts";
import { putMessage, WriteBatch } from "../src/repo/writes.ts";
import type { UploadDb } from "../src/media/upload-queue.ts";
import { FakeMedia, MemoryBlobs } from "./support/fake-media.ts";
import { MemorySqlFactory } from "./support/node-sql.ts";

const wireMedia = create(MediaRefSchema, {
	fileId: "f1",
	fileHash: "ab".repeat(32),
	kind: MediaKind.PHOTO,
	mimeType: "image/jpeg",
	size: 12345n,
	fileName: "a.jpg",
	width: 1280,
	height: 960,
	inlineThumb: new Uint8Array([0xff, 0xd8, 1, 2, 3]),
	sizes: [
		{ type: MediaSizeType.S, width: 320, height: 240, size: 900n },
		{ type: MediaSizeType.M, width: 800, height: 600, size: 4000n },
	],
	waveform: new Uint8Array([1, 30, 31]),
});

interface Store {
	readonly driver: SqlDriver;
	readonly db: UploadDb;
	readonly repo: Repository;
	readonly blobs: MemoryBlobs;
	now: number;
	limits: CacheLimits;
	readonly cache: MediaCache;
	putMessage(chatId: number, seq: number): Promise<void>;
	commit(build: (w: WriteBatch) => void): Promise<void>;
}

async function store(): Promise<Store> {
	const driver = await new MemorySqlFactory().open("m.sqlite3");
	await migrate(driver);
	const commit = async (build: (w: WriteBatch) => void): Promise<void> => {
		const w = new WriteBatch();
		build(w);
		await driver.batch(w.statements);
	};
	const blobs = new MemoryBlobs();
	const blobStore = await blobs.open("s");
	const s: Store = {
		driver,
		db: { query: (sql, params) => driver.query(sql, params), commit },
		repo: new Repository(driver, new EventBus((cb) => queueMicrotask(cb))),
		blobs,
		now: 1_000_000,
		limits: { sizeBytes: 10, largeBytes: 5, maxAgeMs: 1000 },
		cache: null as unknown as MediaCache,
		putMessage: async (chatId, seq) => {
			await commit((w) => {
				putMessage(w, toMessage(create(MessageSchema, { chatId: BigInt(chatId), seq: BigInt(seq), fromId: 9n, media: wireMedia })));
			});
		},
		commit,
	};
	(s as { cache: MediaCache }).cache = new MediaCache({ db: s.db, store: blobStore, now: () => s.now, limits: () => s.limits });
	return s;
}

const blob = (n: number): Blob => new Blob([new Uint8Array(n)]);

async function keys(s: Store): Promise<string[]> {
	return (await s.driver.query("SELECT key FROM media_cache ORDER BY key")).map((r) => String(r.key));
}

describe("media in the model", () => {
	it("maps MediaRef with renditions, thumbnail and waveform, and keeps it in the local store", async () => {
		const message = toMessage(
			create(MessageSchema, {
				chatId: 5n,
				seq: 2n,
				fromId: 9n,
				text: "caption",
				media: wireMedia,
				linkPreview: { url: "https://x.test/", title: "T", photo: { ...wireMedia, fileId: "p1", kind: MediaKind.PHOTO } },
			}),
		);
		expect(message.mediaKind).toBe("photo");
		expect(message.media).toMatchObject({
			fileId: "f1",
			kind: "photo",
			size: 12345,
			width: 1280,
			sizes: [
				{ type: "s", width: 320, height: 240, size: 900 },
				{ type: "m", width: 800, height: 600, size: 4000 },
			],
		});
		expect([...(message.media?.inlineThumb ?? [])]).toEqual([0xff, 0xd8, 1, 2, 3]);
		const s = await store();
		await s.commit((w) => putMessage(w, message));
		const stored = await s.repo.message(5, 2);
		expect(stored?.media).toEqual(message.media);
		expect(stored?.linkPreview?.photo?.fileId).toBe("p1");
		// A recalled message keeps no media.
		await s.commit((w) => recallMessages(w, 5, [2], 1));
		expect((await s.repo.message(5, 2))?.media).toBeUndefined();
	});

	it("leaves text messages without media", () => {
		const message = toMessage(create(MessageSchema, { chatId: 5n, seq: 1n, text: "hi" }));
		expect(message.media).toBeUndefined();
		expect(message.mediaKind).toBeNull();
	});
});

describe("media cache", () => {
	it("evicts the least recently used files past the total budget", async () => {
		const s = await store();
		await s.cache.put("a", blob(4), 1, 1, false);
		s.now++;
		await s.cache.put("b", blob(4), 1, 2, false);
		s.now++;
		expect(await s.cache.get("a")).not.toBeNull();
		s.now++;
		await s.cache.put("c", blob(4), 1, 3, false);
		expect(await keys(s)).toEqual(["a", "c"]);
		expect(await s.cache.get("b")).toBeNull();
		expect(await s.cache.usage()).toEqual({ bytes: 8, largeBytes: 0, files: 2 });
	});

	it("keeps large files and video within their own budget", async () => {
		const s = await store();
		await s.cache.put("small", blob(2), 1, 1, false);
		s.now++;
		await s.cache.put("v1", blob(4), 1, 2, true);
		s.now++;
		await s.cache.put("v2", blob(4), 1, 3, true);
		expect(await keys(s)).toEqual(["small", "v2"]);
		expect(await s.cache.put("huge", blob(6), 1, 4, true)).toBe(false);
		expect(await s.cache.put("too-big", blob(11), 1, 5, false)).toBe(false);
	});

	it("evicts files unused past the age limit", async () => {
		const s = await store();
		await s.cache.put("old", blob(1), 1, 1, false);
		s.now += 2000;
		await s.cache.put("new", blob(1), 1, 2, false);
		expect(await keys(s)).toEqual(["new"]);
	});

	it("drops a file once every message it was shown for is purged or recalled", async () => {
		const s = await store();
		await s.putMessage(5, 1);
		await s.putMessage(5, 2);
		await s.putMessage(6, 1);
		await s.cache.put("shared", blob(1), 5, 1, false);
		await s.cache.addRef("shared", 6, 1);
		await s.cache.put("only", blob(1), 5, 2, false);
		await s.commit((w) => recallMessages(w, 5, [2], 1));
		await s.commit((w) => purgeMessages(w, 5, [1], 1));
		await s.cache.evict();
		expect(await keys(s)).toEqual(["shared"]);
		await s.commit((w) => purgeMessages(w, 6, [1], 1));
		await s.cache.evict();
		expect(await keys(s)).toEqual([]);
		expect(await (await s.blobs.open("s")).get("cache:shared")).toBeNull();
	});

	it("forgets a row whose blob the browser evicted", async () => {
		const s = await store();
		await s.cache.put("a", blob(1), 1, 1, false);
		await (await s.blobs.open("s")).delete("cache:a");
		expect(await s.cache.get("a")).toBeNull();
		expect(await keys(s)).toEqual([]);
	});
});

describe("media loader", () => {
	async function loader(): Promise<{ s: Store; media: FakeMedia; loader: MediaLoader; fileId: string; clock: { now: number } }> {
		const s = await store();
		s.limits = { sizeBytes: 1 << 20, largeBytes: 1 << 20, maxAgeMs: 1e12 };
		const media = new FakeMedia();
		const api = media.apiFor(1);
		const session = await api.createUpload({ kind: MediaKind.PHOTO, size: 3n, fileHash: "h", mimeType: "image/png" });
		if (session.result.case !== "upload") throw new Error("no session");
		const url = session.result.value.parts[0]?.url ?? "";
		const put = await media.http.put(url, new Blob([new Uint8Array([1, 2, 3])]));
		const done = await api.completeUpload({ uploadId: session.result.value.uploadId, parts: [{ partNumber: 1, etag: put.etag }] });
		const clock = { now: Date.now() };
		return {
			s,
			media,
			fileId: done.media?.fileId ?? "",
			clock,
			loader: new MediaLoader({ api, http: media.http, cache: s.cache, now: () => clock.now }),
		};
	}

	it("asks for URLs in batches of at most 100 and reuses them until they expire", async () => {
		const { media, loader: l, fileId } = await loader();
		const urls = await Promise.all(Array.from({ length: URLS_PER_CALL + 20 }, (_, i) => l.url({ chatId: 5, seq: i + 1, fileId })));
		expect(urls.every((u) => u !== null && u.size === "original")).toBe(true);
		expect(media.calls.get("getFileUrls")).toBe(2);
		await l.url({ chatId: 5, seq: 1, fileId });
		expect(media.calls.get("getFileUrls")).toBe(2);
	});

	it("downloads once into the cache and serves later reads from it", async () => {
		const { media, loader: l, fileId } = await loader();
		const first = await l.file({ chatId: 5, seq: 1, fileId, size: "m" });
		expect(first.status).toBe("ok");
		if (first.status === "ok") expect([...new Uint8Array(await first.blob.arrayBuffer())]).toEqual([1, 2, 3]);
		await l.file({ chatId: 5, seq: 1, fileId, size: "m" });
		expect(media.gets).toHaveLength(1);
	});

	it("refreshes an expired URL by (chat_id, seq) once, silently", async () => {
		const { media, loader: l, fileId } = await loader();
		await l.url({ chatId: 5, seq: 1, fileId });
		// The server's clock moved past the URL's expiry; the client still trusts it.
		const base = Date.now() / 1000;
		media.clock = () => Math.floor(base + 4000);
		const result = await l.file({ chatId: 5, seq: 1, fileId });
		expect(result.status).toBe("ok");
		expect(media.calls.get("getFileUrls")).toBe(2);
		expect(media.gets).toHaveLength(2);
	});

	it("reports a revoked message as unavailable and drops its cached file", async () => {
		const { s, media, loader: l, fileId } = await loader();
		await s.putMessage(5, 1);
		expect((await l.file({ chatId: 5, seq: 1, fileId })).status).toBe("ok");
		expect(await keys(s)).toEqual([cacheKey(fileId, "original")]);
		media.revoked.add("5:1");
		expect(await l.url({ chatId: 5, seq: 1, fileId }, true)).toBeNull();
		expect(await keys(s)).toEqual([]);
		// A download with a URL issued before the revocation answers 404.
		const other = await l.url({ chatId: 5, seq: 2, fileId });
		expect(other).not.toBeNull();
		media.revoked.add("5:2");
		expect((await l.file({ chatId: 5, seq: 2, fileId })).status).toBe("unavailable");
	});
});

describe("profile photos", () => {
	it("are fetched in the user_photo_of context and cached like other files", async () => {
		const s = await store();
		s.limits = { sizeBytes: 1 << 20, largeBytes: 1 << 20, maxAgeMs: 1e12 };
		const media = new FakeMedia();
		const api = media.apiFor(1);
		const session = await api.createUpload({ kind: MediaKind.PHOTO, size: 3n, fileHash: "h", mimeType: "image/png" });
		if (session.result.case !== "upload") throw new Error("no session");
		const put = await media.http.put(session.result.value.parts[0]?.url ?? "", new Blob([new Uint8Array([7, 8, 9])]));
		const done = await api.completeUpload({ uploadId: session.result.value.uploadId, parts: [{ partNumber: 1, etag: put.etag }] });
		const fileId = done.media?.fileId ?? "";
		const l = new MediaLoader({ api, http: media.http, cache: s.cache, now: () => Date.now() });
		// Not that user's photo: unavailable.
		expect((await l.file({ chatId: 0, seq: 0, fileId, userPhotoOf: 42, size: "s" })).status).toBe("unavailable");
		media.photos.set(42, fileId);
		const got = await l.file({ chatId: 0, seq: 0, fileId, userPhotoOf: 42, size: "s" });
		expect(got.status).toBe("ok");
		await l.file({ chatId: 0, seq: 0, fileId, userPhotoOf: 42, size: "s" });
		expect(media.gets.filter((u) => u.includes("/photo/42/"))).toHaveLength(1);
	});

	it("maps the user's photo to photoId", () => {
		expect(toUser(create(UserSchema, { id: 5n, name: "Bot", isBot: true, photo: { fileId: "AbCdEfGhIjKlMnOpQrStUv" } })).photoId).toBe("AbCdEfGhIjKlMnOpQrStUv");
		expect(toUser(create(UserSchema, { id: 6n, name: "Người" })).photoId).toBeUndefined();
	});
});

describe("direct photo upload", () => {
	it("uploads a photo outside the outbox and reuses the user's same bytes", async () => {
		const media = new FakeMedia();
		const api = media.apiFor(1);
		const photo = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/jpeg" });
		const fileId = await uploadPhotoNow(api, media.http, photo, "bot.jpg");
		expect(fileId).not.toBe("");
		expect(await uploadPhotoNow(api, media.http, photo, "bot.jpg")).toBe(fileId);
		expect(media.calls.get("completeUpload")).toBe(1);
	});
});
