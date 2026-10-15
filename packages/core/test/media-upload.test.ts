// Resumable multipart uploads: parallel parts with adaptive concurrency,
// ETags persisted and sent on completion, resume after a reload, URL
// refresh, idempotent completion and refused files.
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Code, ConnectError } from "@connectrpc/connect";
import { systemTimers, type BlobStore, type Http, type SqlDriver } from "@app/platform";
import { MediaKind } from "@app/proto-ts/media";
import { Sha256, sha256Blob } from "../src/media/sha256.ts";
import { AdaptiveConcurrency, UploadQueue, uploadBlobKey, type UploadDb, type UploadSpec } from "../src/media/upload-queue.ts";
import { migrate } from "../src/repo/migrations.ts";
import { WriteBatch } from "../src/repo/writes.ts";
import { FakeMedia, MemoryBlobs } from "./support/fake-media.ts";
import { MemorySqlFactory } from "./support/node-sql.ts";

const OWNER = 7;

interface Rig {
	readonly media: FakeMedia;
	readonly driver: SqlDriver;
	readonly db: UploadDb;
	readonly store: BlobStore;
	readonly queues: UploadQueue[];
	queue(http?: Http): UploadQueue;
	add(queue: UploadQueue, spec: Partial<UploadSpec> & { key: string }, bytes: Uint8Array): Promise<void>;
}

const rigs: Rig[] = [];

afterEach(() => {
	for (const rig of rigs.splice(0)) for (const q of rig.queues) q.stop();
});

async function rig(): Promise<Rig> {
	const media = new FakeMedia();
	const driver = await new MemorySqlFactory().open("uploads.sqlite3");
	await migrate(driver);
	const db: UploadDb = {
		query: (sql, params) => driver.query(sql, params),
		commit: async (build) => {
			const w = new WriteBatch();
			build(w);
			await driver.batch(w.statements);
		},
	};
	const store = await new MemoryBlobs().open("store");
	const queues: UploadQueue[] = [];
	const r: Rig = {
		media,
		driver,
		db,
		store,
		queues,
		queue: (http = media.http) => {
			const q = new UploadQueue({
				api: media.apiFor(OWNER),
				http,
				store,
				db,
				timers: systemTimers,
				backoff: { baseMs: 1, maxMs: 4 },
				emit: () => undefined,
				onSessionEnded: () => undefined,
			});
			queues.push(q);
			return q;
		},
		add: async (queue, spec, bytes) => {
			const w = new WriteBatch();
			await queue.prepare(
				{
					kind: "document",
					fileName: "a.bin",
					mimeType: "application/octet-stream",
					size: bytes.length,
					width: 0,
					height: 0,
					duration: 0,
					inlineThumb: new Uint8Array(),
					waveform: new Uint8Array(),
					...spec,
				},
				new Blob([bytes.slice()]),
				w,
				Date.now(),
			);
			await driver.batch(w.statements);
		},
	};
	rigs.push(r);
	return r;
}

function bytes(n: number, seed = 1): Uint8Array {
	const out = new Uint8Array(n);
	for (let i = 0; i < n; i++) out[i] = (i * 31 + seed * 7) & 0xff;
	return out;
}

const hex = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

async function until(check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
	const end = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > end) throw new Error("condition not reached");
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
}

describe("SHA-256", () => {
	it("matches node:crypto across block and chunk boundaries", async () => {
		for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 128, 1000, 4097]) {
			const data = bytes(n, n);
			const split = new Sha256().update(data.subarray(0, n >> 1)).update(data.subarray(n >> 1)).hex();
			expect(split).toBe(hex(data));
		}
		const big = bytes((4 << 20) + 123, 3);
		expect(await sha256Blob(new Blob([big]))).toBe(hex(big));
	});
});

describe("adaptive concurrency", () => {
	it("grows after a run of fast parts and halves on slow or failed ones", () => {
		const c = new AdaptiveConcurrency({ initial: 3, min: 1, max: 6, slowMs: 1000 });
		expect(c.current).toBe(3);
		for (let i = 0; i < 3; i++) c.onSuccess(10);
		expect(c.current).toBe(4);
		for (let i = 0; i < 20; i++) c.onSuccess(10);
		expect(c.current).toBe(6);
		c.onSuccess(5000);
		expect(c.current).toBe(3);
		c.onFailure();
		c.onFailure();
		c.onFailure();
		expect(c.current).toBe(1);
	});
});

describe("upload queue", () => {
	it("uploads parts in parallel and completes with every part's ETag", async () => {
		const r = await rig();
		const q = r.queue();
		await q.start();
		const data = bytes(40);
		await r.add(q, { key: "k1" }, data);
		const done = q.waitFor("k1");
		const media = await done;
		expect(media.fileHash).toBe(hex(data));
		expect(r.media.bytesOf(media.fileId)).toEqual(data);
		expect(r.media.maxInFlight).toBeGreaterThan(1);
		expect(r.media.maxInFlight).toBeLessThanOrEqual(6);
		expect(r.media.puts.toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		expect(r.media.calls.get("completeUpload")).toBe(1);
		expect(await q.progress("k1")).toMatchObject({ state: "done", sentBytes: 40, totalBytes: 40 });
	});

	it("resumes after a reload with only the parts it did not store, trusting its own ETags", async () => {
		const r = await rig();
		r.media.putFault = (part) => (part > 3 ? 500 : null);
		const first = r.queue();
		await first.start();
		const data = bytes(24, 2);
		await r.add(first, { key: "k" }, data);
		first.schedule("k");
		await until(async () => {
			const row = (await r.driver.query("SELECT parts FROM uploads WHERE key = 'k'"))[0];
			return typeof row?.parts === "string" && (JSON.parse(row.parts) as unknown[]).length === 3;
		});
		first.stop();
		const stored = r.media.puts.length;
		expect(stored).toBe(3);

		// "Reload": a new queue over the same database and files.
		r.media.putFault = null;
		const second = r.queue();
		await second.start();
		const media = await second.waitFor("k");
		expect(r.media.bytesOf(media.fileId)).toEqual(data);
		expect(r.media.puts.slice(stored).toSorted((a, b) => a - b)).toEqual([4, 5, 6]);
	});

	it("refreshes part URLs answered with 403 and retries the part", async () => {
		const r = await rig();
		r.media.putFault = (part, attempt) => (part === 2 && attempt === 1 ? 403 : null);
		const q = r.queue();
		await q.start();
		await r.add(q, { key: "k" }, bytes(12));
		const media = await q.waitFor("k");
		expect(r.media.bytesOf(media.fileId)).toEqual(bytes(12));
		expect(r.media.calls.get("createUpload")).toBe(2);
	});

	it("gets the same file when the CompleteUpload answer was lost", async () => {
		const r = await rig();
		r.media.completeFault = { code: Code.Unavailable, lostResponse: true };
		const q = r.queue();
		await q.start();
		await r.add(q, { key: "k" }, bytes(9));
		const media = await q.waitFor("k");
		expect(r.media.calls.get("completeUpload")).toBe(2);
		expect(r.media.files.size).toBe(1);
		expect(media.fileId).toBe([...r.media.files.keys()][0]);
	});

	it("uploads every part again when the server cannot assemble the listed parts", async () => {
		const r = await rig();
		r.media.completeFault = { code: Code.FailedPrecondition, lostResponse: false };
		const q = r.queue();
		await q.start();
		await r.add(q, { key: "k" }, bytes(8));
		const media = await q.waitFor("k");
		expect(r.media.bytesOf(media.fileId)).toEqual(bytes(8));
		expect(r.media.puts.toSorted((a, b) => a - b)).toEqual([1, 1, 2, 2]);
	});

	it("starts a new session when the old one expired", async () => {
		const r = await rig();
		r.media.putFault = () => 500;
		const first = r.queue();
		await first.start();
		await r.add(first, { key: "k" }, bytes(8));
		first.schedule("k");
		await until(async () => (await r.driver.query("SELECT upload_id FROM uploads WHERE upload_id IS NOT NULL")).length === 1);
		first.stop();
		const old = String((await r.driver.query("SELECT upload_id FROM uploads"))[0]?.upload_id);
		r.media.expired.add(old);
		r.media.putFault = null;
		const second = r.queue();
		await second.start();
		const media = await second.waitFor("k");
		expect(r.media.bytesOf(media.fileId)).toEqual(bytes(8));
	});

	it("needs no upload when the owner already has the file", async () => {
		const r = await rig();
		const q = r.queue();
		await q.start();
		await r.add(q, { key: "a" }, bytes(10));
		const first = await q.waitFor("a");
		const puts = r.media.puts.length;
		await r.add(q, { key: "b" }, bytes(10));
		const second = await q.waitFor("b");
		expect(second.fileId).toBe(first.fileId);
		expect(r.media.puts.length).toBe(puts);
	});

	it("fails for good on refused content and starts over when asked again", async () => {
		const r = await rig();
		r.media.refuse.add(MediaKind.PHOTO);
		const q = r.queue();
		await q.start();
		await r.add(q, { key: "k", kind: "photo" }, bytes(6));
		const error = await q.waitFor("k").catch((err: unknown) => ConnectError.from(err));
		expect(error).toBeInstanceOf(ConnectError);
		expect((error as ConnectError).code).toBe(Code.InvalidArgument);
		expect(await q.progress("k")).toMatchObject({ state: "failed" });
		r.media.refuse.clear();
		const media = await q.waitFor("k");
		expect(r.media.bytesOf(media.fileId)).toEqual(bytes(6));
	});

	it("refuses an upload whose storage hides the ETag (CORS)", async () => {
		const r = await rig();
		const blind: Http = {
			put: async (url, body, signal) => ({ ...(await r.media.http.put(url, body, signal)), etag: "" }),
			get: r.media.http.get,
		};
		const q = r.queue(blind);
		await q.start();
		await r.add(q, { key: "k" }, bytes(4));
		const error = ConnectError.from(await q.waitFor("k").catch((err: unknown) => err));
		expect(error.code).toBe(Code.FailedPrecondition);
	});

	it("removes an upload with its file and server session", async () => {
		const r = await rig();
		r.media.putFault = () => 500;
		const q = r.queue();
		await q.start();
		await r.add(q, { key: "k" }, bytes(8));
		const waiting = q.waitFor("k").then(
			() => new ConnectError("uploaded", Code.Unknown),
			(err: unknown) => ConnectError.from(err),
		);
		await until(async () => (await r.driver.query("SELECT 1 FROM uploads WHERE upload_id IS NOT NULL")).length === 1);
		await q.remove(["k"]);
		expect((await waiting).code).toBe(Code.FailedPrecondition);
		expect(await r.store.get(uploadBlobKey("k"))).toBeNull();
		expect(await r.driver.query("SELECT * FROM uploads")).toEqual([]);
		expect(r.media.calls.get("abortUpload")).toBe(1);
	});
});
