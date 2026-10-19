// Resumable media uploads (multipart, presigned part URLs). Every queued
// upload has a row in the local `uploads` table and its file in the
// platform BlobStore, so an upload survives a reload or a crash and resumes
// from the parts already stored:
// - the file is hashed (SHA-256) in chunks, then CreateUpload opens (or, with
//   the saved upload_id, resumes) a session;
// - parts go up in parallel, the number in flight adapting to how fast they
//   go (grow after a run of fast parts, halve on a slow or failed one);
// - every part's ETag is persisted as soon as it is stored, and
//   CompleteUpload sends them all; the storage cannot be asked which parts
//   it holds, so the client's list is the truth;
// - expired part URLs (403) are refreshed with CreateUpload(upload_id);
// - network trouble backs off and resumes; a refused file fails for good
//   until the user retries.
import { Code, ConnectError } from "@connectrpc/connect";
import type { BlobStore, Http, SqlParams, SqlRow, Timers } from "@app/platform";
import type { MediaKind, MediaRef } from "../model/types.ts";
import { classifyFailure, type RemoteApi } from "../protocol/api.ts";
import { toMediaRef, toWireMediaKind } from "../protocol/map.ts";
import { num, str } from "../repo/rows.ts";
import type { WriteBatch } from "../repo/writes.ts";
import { backoffDelay, DEFAULT_BACKOFF, type BackoffPolicy } from "../transport/backoff.ts";
import { decodeMediaRef, encodeMediaRef } from "./codec.ts";
import { sha256Blob } from "./sha256.ts";

/** What the server needs to know about a file before it is uploaded. */
export interface UploadSpec {
	readonly key: string;
	readonly kind: MediaKind;
	readonly fileName: string;
	readonly mimeType: string;
	readonly size: number;
	readonly width: number;
	readonly height: number;
	/** Milliseconds. */
	readonly duration: number;
	readonly inlineThumb: Uint8Array;
	readonly waveform: Uint8Array;
}

/** paused: the user paused it (UploadQueue.pause); the parts stored so far are kept. */
export type UploadState = "queued" | "hashing" | "uploading" | "completing" | "paused" | "done" | "failed";

export interface UploadProgress {
	readonly key: string;
	readonly state: UploadState;
	/** Bytes of the parts stored so far. */
	readonly sentBytes: number;
	readonly totalBytes: number;
	readonly failure: string | null;
}

/** The local database as the queue uses it: reads, and writes through the engine's serial commit. */
export interface UploadDb {
	query(sql: string, params?: SqlParams): Promise<SqlRow[]>;
	commit(build: (w: WriteBatch) => void): Promise<void>;
}

export interface ConcurrencyPolicy {
	readonly initial: number;
	readonly min: number;
	readonly max: number;
	/** A part slower than this counts as congestion. */
	readonly slowMs: number;
}

export const DEFAULT_CONCURRENCY: ConcurrencyPolicy = { initial: 3, min: 1, max: 6, slowMs: 20_000 };

/**
 * Parts in flight, additive increase / multiplicative decrease: after as
 * many fast parts in a row as are in flight, one more; a slow or failed
 * part halves it.
 */
export class AdaptiveConcurrency {
	private value: number;
	private streak = 0;

	constructor(private readonly policy: ConcurrencyPolicy = DEFAULT_CONCURRENCY) {
		this.value = Math.min(policy.max, Math.max(policy.min, policy.initial));
	}

	get current(): number {
		return this.value;
	}

	onSuccess(elapsedMs: number): void {
		if (elapsedMs > this.policy.slowMs) {
			this.decrease();
			return;
		}
		this.streak++;
		if (this.streak >= this.value && this.value < this.policy.max) {
			this.value++;
			this.streak = 0;
		}
	}

	onFailure(): void {
		this.decrease();
	}

	private decrease(): void {
		this.value = Math.max(this.policy.min, Math.floor(this.value / 2));
		this.streak = 0;
	}
}

export interface UploadQueueOptions {
	readonly api: NonNullable<RemoteApi["media"]>;
	readonly http: Http;
	readonly store: BlobStore;
	readonly db: UploadDb;
	readonly timers: Timers;
	readonly random?: () => number;
	readonly backoff?: BackoffPolicy;
	readonly concurrency?: ConcurrencyPolicy;
	/** Files uploading at the same time; the others wait. */
	readonly maxFiles?: number;
	/** Called with EventKeys.upload(key) when an upload's progress changes. */
	readonly emit: (uploadKey: string) => void;
	readonly onSessionEnded: () => void;
	readonly onError?: (error: unknown, context: string) => void;
}

/** Tries of one part before the upload backs off as a whole. */
const PART_TRIES = 5;
/** Refresh part URLs this long before they expire. */
const URL_MARGIN_S = 60;
/** CompleteUpload refusals for missing parts (each re-uploads every part) before the upload fails. */
const COMPLETE_RETRIES = 2;

/** Blob store key of a pending upload's file. */
export function uploadBlobKey(uploadKey: string): string {
	return `upload:${uploadKey}`;
}

interface UploadRow extends UploadSpec {
	fileHash: string | null;
	uploadId: string | null;
	partSize: number;
	/** part number -> ETag of the parts stored. */
	parts: Map<number, string>;
	media: MediaRef | null;
	failure: string | null;
}

function parseParts(raw: string): Map<number, string> {
	const out = new Map<number, string>();
	try {
		const value = JSON.parse(raw) as unknown;
		if (!Array.isArray(value)) return out;
		for (const item of value) {
			if (Array.isArray(item) && typeof item[0] === "number" && typeof item[1] === "string") out.set(item[0], item[1]);
		}
	} catch {
		// A corrupt list re-uploads every part.
	}
	return out;
}

function bytesOf(row: SqlRow, column: string): Uint8Array {
	const value = row[column];
	return value instanceof Uint8Array ? value : new Uint8Array();
}

function toRow(row: SqlRow): UploadRow {
	const media = typeof row.media === "string" ? decodeMediaRef(JSON.parse(row.media) as unknown) : null;
	return {
		key: str(row, "key"),
		kind: str(row, "kind") as MediaKind,
		fileName: str(row, "file_name"),
		mimeType: str(row, "mime_type"),
		size: num(row, "size"),
		width: num(row, "width"),
		height: num(row, "height"),
		duration: num(row, "duration"),
		inlineThumb: bytesOf(row, "inline_thumb"),
		waveform: bytesOf(row, "waveform"),
		fileHash: typeof row.file_hash === "string" ? row.file_hash : null,
		uploadId: typeof row.upload_id === "string" ? row.upload_id : null,
		partSize: num(row, "part_size"),
		parts: parseParts(str(row, "parts")),
		media,
		failure: typeof row.failure === "string" ? row.failure : null,
	};
}

/** A refused upload: retrying the same file cannot help (the outbox marks the send failed). */
function permanent(message: string): ConnectError {
	return new ConnectError(message, Code.FailedPrecondition);
}

interface Waiter {
	resolve(media: MediaRef): void;
	reject(error: unknown): void;
}

interface Job {
	readonly key: string;
	readonly abort: AbortController;
	state: UploadState;
	sentBytes: number;
	totalBytes: number;
}

interface Session {
	partSize: number;
	urls: Map<number, string>;
	expiresAt: number;
}

export class UploadQueue {
	private running = false;
	private readonly jobs = new Map<string, Job>();
	private readonly waiting: string[] = [];
	private readonly waiters = new Map<string, Waiter[]>();
	/** Uploads the user paused; they wait (and their sends with them) until resumed. */
	private readonly paused = new Set<string>();
	private readonly random: () => number;
	private readonly backoff: BackoffPolicy;
	private readonly maxFiles: number;
	/** CompleteUpload refusals (missing parts) per upload in this run. */
	private readonly refusals = new Map<string, number>();

	constructor(private readonly options: UploadQueueOptions) {
		this.random = options.random ?? Math.random;
		this.backoff = options.backoff ?? DEFAULT_BACKOFF;
		this.maxFiles = options.maxFiles ?? 2;
	}

	get busy(): boolean {
		return this.jobs.size > 0 || this.waiting.length > 0;
	}

	/** Resumes every unfinished upload (after a start or a reconnect). */
	async start(): Promise<void> {
		this.running = true;
		const rows = await this.options.db.query("SELECT key, paused FROM uploads WHERE media IS NULL AND failure IS NULL ORDER BY created_at");
		for (const row of rows) {
			const key = str(row, "key");
			if (row.paused === 1) this.paused.add(key);
			else this.schedule(key);
		}
	}

	/** Stops every transfer; waiting callers get a retryable error. */
	stop(): void {
		this.running = false;
		this.waiting.length = 0;
		for (const job of this.jobs.values()) job.abort.abort();
		for (const [key, list] of this.waiters) {
			this.waiters.delete(key);
			for (const waiter of list) waiter.reject(new ConnectError("uploads stopped", Code.Unavailable));
		}
	}

	/**
	 * Adds the statements that queue an upload to `w` (commit them with the
	 * operation that needs it); the file is stored first. Call `schedule`
	 * after the commit.
	 */
	async prepare(spec: UploadSpec, file: Blob, w: WriteBatch, now: number): Promise<void> {
		await this.options.store.put(uploadBlobKey(spec.key), file);
		w.add(
			`INSERT INTO uploads (key, kind, file_name, mime_type, size, width, height, duration, inline_thumb, waveform, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				spec.key,
				spec.kind,
				spec.fileName,
				spec.mimeType,
				spec.size,
				spec.width,
				spec.height,
				spec.duration,
				spec.inlineThumb.length === 0 ? null : spec.inlineThumb,
				spec.waveform.length === 0 ? null : spec.waveform,
				now,
			],
		);
	}

	/** Starts (or queues) the upload of `key` unless it runs already or is paused. */
	schedule(key: string): void {
		if (!this.running || this.paused.has(key) || this.jobs.has(key) || this.waiting.includes(key)) return;
		this.waiting.push(key);
		this.pump();
	}

	/**
	 * The uploaded file of `key`. A failed upload starts over (the user asked
	 * to retry the send). Rejects with a permanent ConnectError when the file
	 * is refused or gone, a retryable one when the queue stops.
	 */
	async waitFor(key: string): Promise<MediaRef> {
		const row = await this.load(key);
		if (row === null) throw permanent("the file to send is no longer available");
		if (row.media !== null) return row.media;
		if (!this.running) throw new ConnectError("uploads stopped", Code.Unavailable);
		const done = new Promise<MediaRef>((resolve, reject) => {
			const list = this.waiters.get(key) ?? [];
			list.push({ resolve, reject });
			this.waiters.set(key, list);
		});
		if (row.failure !== null) {
			await this.options.db.commit((w) => {
				w.add("UPDATE uploads SET failure = NULL WHERE key = ?", [key]);
			});
		}
		this.schedule(key);
		return done;
	}

	/**
	 * Pauses an unfinished upload: its transfer stops, the parts stored so
	 * far stay (the server keeps the session for 24 h), and its send waits.
	 */
	async pause(key: string): Promise<void> {
		const row = await this.load(key);
		if (row === null || row.media !== null || this.paused.has(key)) return;
		this.paused.add(key);
		await this.options.db.commit((w) => {
			w.add("UPDATE uploads SET paused = 1 WHERE key = ?", [key]);
		});
		const index = this.waiting.indexOf(key);
		if (index >= 0) this.waiting.splice(index, 1);
		this.jobs.get(key)?.abort.abort();
		this.options.emit(key);
	}

	/** Resumes a paused upload from the parts it stored. */
	async resume(key: string): Promise<void> {
		if (!this.paused.delete(key)) return;
		await this.options.db.commit((w) => {
			w.add("UPDATE uploads SET paused = 0 WHERE key = ?", [key]);
		});
		this.schedule(key);
		this.options.emit(key);
	}

	async progress(key: string): Promise<UploadProgress | null> {
		const job = this.jobs.get(key);
		// A paused job may still be winding down: report it paused at once.
		if (job !== undefined && !this.paused.has(key)) {
			return { key, state: job.state, sentBytes: job.sentBytes, totalBytes: job.totalBytes, failure: null };
		}
		const row = await this.load(key);
		if (row === null) return null;
		const sent = row.media !== null ? row.size : this.storedBytes(row);
		const state: UploadState =
			row.media !== null ? "done" : row.failure !== null ? "failed" : this.paused.has(key) ? "paused" : "queued";
		return { key, state, sentBytes: sent, totalBytes: row.size, failure: row.failure };
	}

	/** The file of a pending upload, for showing it locally. */
	async file(key: string): Promise<Blob | null> {
		return this.options.store.get(uploadBlobKey(key));
	}

	/**
	 * Drops uploads: stops them, abandons their server sessions and deletes
	 * rows and files (send discarded, or confirmed and its file adopted).
	 */
	async remove(keys: readonly string[], abandonSession = true): Promise<void> {
		for (const key of keys) {
			const row = await this.load(key);
			const job = this.jobs.get(key);
			job?.abort.abort();
			this.paused.delete(key);
			const index = this.waiting.indexOf(key);
			if (index >= 0) this.waiting.splice(index, 1);
			for (const waiter of this.waiters.get(key) ?? []) waiter.reject(permanent("upload canceled"));
			this.waiters.delete(key);
			await this.options.db.commit((w) => {
				w.add("DELETE FROM uploads WHERE key = ?", [key]);
			});
			await this.options.store.delete(uploadBlobKey(key));
			if (abandonSession && row?.uploadId !== null && row?.uploadId !== undefined && row.media === null) {
				try {
					await this.options.api.abortUpload({ uploadId: row.uploadId });
				} catch (err) {
					// The server drops abandoned sessions after 24 h anyway.
					this.options.onError?.(err, `abort upload ${key}`);
				}
			}
			this.options.emit(key);
		}
	}

	/** Deletes uploads no queued operation refers to (their send was purged with its chat). */
	async dropOrphans(referenced: ReadonlySet<string>): Promise<void> {
		const rows = await this.options.db.query("SELECT key FROM uploads");
		const orphans = rows.map((row) => str(row, "key")).filter((key) => !referenced.has(key));
		if (orphans.length > 0) await this.remove(orphans);
	}

	// ------------------------------------------------------------- running

	private pump(): void {
		while (this.running && this.jobs.size < this.maxFiles && this.waiting.length > 0) {
			const key = this.waiting.shift();
			if (key === undefined) return;
			const job: Job = { key, abort: new AbortController(), state: "queued", sentBytes: 0, totalBytes: 0 };
			this.jobs.set(key, job);
			void this.run(job).finally(() => {
				this.jobs.delete(key);
				this.options.emit(key);
				this.pump();
			});
		}
	}

	private settle(key: string, outcome: { media: MediaRef } | { error: unknown }): void {
		const list = this.waiters.get(key) ?? [];
		this.waiters.delete(key);
		for (const waiter of list) {
			if ("media" in outcome) waiter.resolve(outcome.media);
			else waiter.reject(outcome.error);
		}
	}

	private async run(job: Job): Promise<void> {
		for (let attempt = 0; ; attempt++) {
			if (!this.running || job.abort.signal.aborted) return;
			try {
				const media = await this.attempt(job);
				await this.options.db.commit((w) => {
					w.add("UPDATE uploads SET media = ?, failure = NULL WHERE key = ?", [encodeMediaRef(media), job.key]);
				});
				job.state = "done";
				this.refusals.delete(job.key);
				this.settle(job.key, { media });
				return;
			} catch (err) {
				if (job.abort.signal.aborted) return;
				switch (classifyFailure(err)) {
					case "unauthenticated":
						this.running = false;
						this.options.onSessionEnded();
						this.settle(job.key, { error: err });
						return;
					case "permanent": {
						const failure = err instanceof Error ? err.message : String(err);
						await this.options.db.commit((w) => {
							w.add("UPDATE uploads SET failure = ? WHERE key = ?", [failure, job.key]);
						});
						job.state = "failed";
						this.settle(job.key, { error: err });
						return;
					}
					case "retryable":
						this.options.onError?.(err, `upload ${job.key}`);
						await this.sleep(backoffDelay(attempt, this.backoff, this.random), job.abort.signal);
				}
			}
		}
	}

	private async attempt(job: Job): Promise<MediaRef> {
		const row = await this.load(job.key);
		if (row === null) throw permanent("the file to send is no longer available");
		const file = await this.options.store.get(uploadBlobKey(job.key));
		if (file === null) throw permanent("the file to send is no longer available on this device");
		job.totalBytes = row.size;
		if (row.fileHash === null) {
			job.state = "hashing";
			this.options.emit(job.key);
			row.fileHash = await sha256Blob(file, job.abort.signal);
			await this.save(row, "file_hash = ?", [row.fileHash]);
		}
		const opened = await this.open(row);
		if ("media" in opened) return opened.media;
		const session = opened.session;
		job.state = "uploading";
		job.sentBytes = this.storedBytes(row);
		this.options.emit(job.key);
		const count = Math.max(1, Math.ceil(row.size / session.partSize));
		const missing: number[] = [];
		for (let part = 1; part <= count; part++) if (!row.parts.has(part)) missing.push(part);
		await this.uploadParts(job, row, file, session, missing);
		job.state = "completing";
		this.options.emit(job.key);
		try {
			const response = await this.options.api.completeUpload({
				uploadId: row.uploadId ?? "",
				parts: [...row.parts.entries()].sort(([a], [b]) => a - b).map(([partNumber, etag]) => ({ partNumber, etag })),
			});
			if (response.media === undefined) throw new ConnectError("CompleteUpload returned no media", Code.Internal);
			return toMediaRef(response.media);
		} catch (err) {
			const code = ConnectError.from(err).code;
			if (code === Code.FailedPrecondition) {
				// The storage does not hold the parts as listed (a lost or wrong
				// ETag). It cannot say which, so every part goes up again; after
				// repeated refusals the upload fails for good.
				const refusals = (this.refusals.get(row.key) ?? 0) + 1;
				this.refusals.set(row.key, refusals);
				if (refusals > COMPLETE_RETRIES) {
					this.refusals.delete(row.key);
					throw permanent("the server could not assemble the uploaded file");
				}
				row.parts = new Map();
				await this.save(row, "parts = '[]'", []);
				throw new ConnectError("parts missing; uploading them again", Code.Aborted);
			}
			if (code === Code.NotFound) {
				await this.forgetSession(row);
				throw new ConnectError("upload session expired; starting over", Code.Aborted);
			}
			throw err;
		}
	}

	/** Opens or resumes the server session; the caller's own file when the server already has it. */
	private async open(row: UploadRow): Promise<{ media: MediaRef } | { session: Session }> {
		const api = this.options.api;
		let response: Awaited<ReturnType<typeof api.createUpload>> | null = null;
		if (row.uploadId !== null) {
			try {
				response = await api.createUpload({ uploadId: row.uploadId });
			} catch (err) {
				if (ConnectError.from(err).code !== Code.NotFound) throw err;
				// Expired (24 h): start over with a new session.
				await this.forgetSession(row);
			}
		}
		response ??= await api.createUpload({
			kind: toWireMediaKind(row.kind),
			fileName: row.fileName,
			mimeType: row.mimeType,
			size: BigInt(row.size),
			fileHash: row.fileHash ?? "",
			width: row.width,
			height: row.height,
			duration: row.duration,
			inlineThumb: row.inlineThumb,
			waveform: row.waveform,
		});
		const result = response.result;
		switch (result.case) {
			case "existing":
				return { media: toMediaRef(result.value) };
			case "upload": {
				const value = result.value;
				const partSize = Number(value.partSize);
				if (!Number.isSafeInteger(partSize) || partSize <= 0) throw new ConnectError("bad part size", Code.Internal);
				const changed = row.uploadId !== value.uploadId || row.partSize !== partSize;
				if (changed) {
					row.uploadId = value.uploadId;
					row.partSize = partSize;
					row.parts = new Map();
				}
				// Parts the server reports stored complete the client's list.
				for (const part of value.completedParts) if (!row.parts.has(part.partNumber)) row.parts.set(part.partNumber, part.etag);
				await this.save(row, "upload_id = ?, part_size = ?, parts = ?", [
					value.uploadId,
					partSize,
					JSON.stringify([...row.parts.entries()]),
				]);
				return { session: { partSize, urls: new Map(value.parts.map((p) => [p.partNumber, p.url])), expiresAt: Number(value.urlsExpireAt) } };
			}
			case undefined:
				throw new ConnectError("CreateUpload returned nothing", Code.Internal);
		}
	}

	private async forgetSession(row: UploadRow): Promise<void> {
		row.uploadId = null;
		row.partSize = 0;
		row.parts = new Map();
		await this.save(row, "upload_id = NULL, part_size = 0, parts = '[]'", []);
	}

	private async uploadParts(job: Job, row: UploadRow, file: Blob, session: Session, parts: readonly number[]): Promise<void> {
		const queue = [...parts];
		const limit = new AdaptiveConcurrency(this.options.concurrency ?? DEFAULT_CONCURRENCY);
		let refreshing: Promise<void> | null = null;
		const refresh = async (): Promise<void> => {
			refreshing ??= (async () => {
				try {
					const response = await this.options.api.createUpload({ uploadId: row.uploadId ?? "" });
					if (response.result.case !== "upload") throw new ConnectError("upload session changed", Code.Aborted);
					for (const part of response.result.value.parts) session.urls.set(part.partNumber, part.url);
					session.expiresAt = Number(response.result.value.urlsExpireAt);
				} finally {
					refreshing = null;
				}
			})();
			await refreshing;
		};
		const send = async (part: number): Promise<void> => {
			const start = (part - 1) * session.partSize;
			const body = file.slice(start, Math.min(start + session.partSize, row.size));
			for (let tries = 0; ; tries++) {
				if (this.options.timers.now() / 1000 > session.expiresAt - URL_MARGIN_S || !session.urls.has(part)) await refresh();
				const url = session.urls.get(part);
				if (url === undefined) throw new ConnectError(`no URL for part ${part}`, Code.Internal);
				const began = this.options.timers.now();
				let status = 0;
				let etag = "";
				try {
					const result = await this.options.http.put(url, body, job.abort.signal);
					status = result.status;
					etag = result.etag;
				} catch (err) {
					if (job.abort.signal.aborted) throw err;
				}
				if (status >= 200 && status < 300 && etag === "") {
					// Without ETags the upload can never be completed: the storage's
					// CORS rules must expose the header.
					throw permanent("the storage did not return the part's ETag");
				}
				if (status >= 200 && status < 300) {
					limit.onSuccess(this.options.timers.now() - began);
					row.parts.set(part, etag);
					await this.save(row, "parts = ?", [JSON.stringify([...row.parts.entries()])]);
					job.sentBytes += body.size;
					this.options.emit(job.key);
					return;
				}
				if (status === 401 || status === 403) {
					// Expired or rejected signature: fresh URLs, same part.
					session.expiresAt = 0;
				} else {
					limit.onFailure();
				}
				if (tries + 1 >= PART_TRIES) throw new ConnectError(`part ${part} failed (HTTP ${status})`, Code.Unavailable);
				await this.sleep(backoffDelay(tries, this.backoff, this.random), job.abort.signal);
			}
		};
		await new Promise<void>((resolve, reject) => {
			let inFlight = 0;
			let failed = false;
			const next = (): void => {
				if (failed) return;
				if (queue.length === 0 && inFlight === 0) {
					resolve();
					return;
				}
				while (!failed && inFlight < limit.current && queue.length > 0) {
					const part = queue.shift();
					if (part === undefined) break;
					inFlight++;
					send(part).then(
						() => {
							inFlight--;
							next();
						},
						(err: unknown) => {
							failed = true;
							reject(err);
						},
					);
				}
			};
			next();
		});
	}

	// ---------------------------------------------------------------- rows

	private storedBytes(row: UploadRow): number {
		if (row.partSize === 0) return 0;
		let sent = 0;
		for (const part of row.parts.keys()) sent += Math.max(0, Math.min(row.partSize, row.size - (part - 1) * row.partSize));
		return sent;
	}

	private async load(key: string): Promise<UploadRow | null> {
		const rows = await this.options.db.query("SELECT * FROM uploads WHERE key = ?", [key]);
		const row = rows[0];
		return row === undefined ? null : toRow(row);
	}

	private async save(row: UploadRow, set: string, params: SqlParams): Promise<void> {
		await this.options.db.commit((w) => {
			w.add(`UPDATE uploads SET ${set} WHERE key = ?`, [...params, row.key]);
		});
	}

	private sleep(ms: number, signal: AbortSignal): Promise<void> {
		return new Promise((resolve) => {
			if (signal.aborted) {
				resolve();
				return;
			}
			const handle = this.options.timers.setTimeout(() => {
				signal.removeEventListener("abort", done);
				resolve();
			}, ms);
			const done = (): void => {
				this.options.timers.clearTimeout(handle);
				resolve();
			};
			signal.addEventListener("abort", done, { once: true });
		});
	}
}
