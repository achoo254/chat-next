// Offline outbox with optimistic local state. Every user operation is
// written locally first (pending message, edited text, removed messages,
// read mark) together with an outbox row, then sent:
// - operations of one chat run strictly in order (send, edit, delete, read);
//   different chats run in parallel;
// - network trouble retries with jittered backoff and the same random_id, so
//   the server never creates a duplicate;
// - a refused operation stays in the outbox marked failed until the user
//   retries or discards it; later operations of the chat continue.
import type { Timers } from "@app/platform";
import { codePointLength, validateEntities } from "../entities/index.ts";
import { EventKeys } from "../events/bus.ts";
import type { MediaKind, MediaRef, Message, MessageEntity, SyncAck } from "../model/types.ts";
import { fromBase64, toBase64 } from "../media/codec.ts";
import type { UploadQueue, UploadSpec } from "../media/upload-queue.ts";
import { purgeMessages, recallMessages } from "../purge/index.ts";
import { classifyFailure, type RemoteApi } from "../protocol/api.ts";
import { toMessage, toSyncAck, toWireEntity, toWireId } from "../protocol/map.ts";
import type { OutboxRow, Repository } from "../repo/repository.ts";
import { decodeEntities } from "../repo/rows.ts";
import {
	messageSearchText,
	putLocalRead,
	putMessage,
	putNewMessage,
	putUnreadMark,
	type WriteBatch,
} from "../repo/writes.ts";
import { assertSafeId } from "../ids/index.ts";
import type { SyncEngine } from "../sync/engine.ts";
import { backoffDelay, DEFAULT_BACKOFF, type BackoffPolicy } from "../transport/backoff.ts";

export type OutboxOperation =
	| {
			readonly kind: "send";
			readonly text: string;
			readonly entities: readonly MessageEntity[];
			readonly replyToSeq: number;
			readonly date: number;
			/** The sender dropped the link preview of the message. */
			readonly noLinkPreview: boolean;
	  }
	| { readonly kind: "edit"; readonly seq: number; readonly text: string; readonly entities: readonly MessageEntity[] }
	| { readonly kind: "delete"; readonly seqs: readonly number[]; readonly forEveryone: boolean }
	| { readonly kind: "read"; readonly maxSeq: number }
	| {
			readonly kind: "send_media";
			readonly text: string;
			readonly entities: readonly MessageEntity[];
			readonly replyToSeq: number;
			readonly date: number;
			readonly topicId: number;
			readonly silent: boolean;
			readonly media: PendingMedia;
	  }
	| {
			readonly kind: "send_album";
			readonly replyToSeq: number;
			readonly date: number;
			readonly topicId: number;
			readonly silent: boolean;
			readonly items: readonly AlbumOperationItem[];
	  };

/** A file of a queued media send, as shown before the server confirms it. */
export interface PendingMedia {
	/** Key of the upload (progress, local file); equals the item's random_id. */
	readonly uploadKey: string;
	readonly kind: MediaKind;
	readonly fileName: string;
	readonly mimeType: string;
	readonly size: number;
	readonly width: number;
	readonly height: number;
	/** Milliseconds. */
	readonly duration: number;
	/** Tiny thumbnail made on this device; empty when none. */
	readonly inlineThumb: Uint8Array;
}

export interface AlbumOperationItem {
	readonly randomId: number;
	readonly text: string;
	readonly entities: readonly MessageEntity[];
	readonly media: PendingMedia;
}

/** Describes a file to send; what the caller does not know stays 0/empty and the server measures what it can. */
export interface MediaInput {
	readonly kind: Exclude<MediaKind, "unknown">;
	readonly fileName?: string;
	readonly mimeType?: string;
	readonly width?: number;
	readonly height?: number;
	/** Milliseconds (video, audio, voice). */
	readonly duration?: number;
	/** Tiny JPEG/PNG/WebP (<= 2048 bytes, <= 64x64) shown before upload ends. */
	readonly inlineThumb?: Uint8Array;
	/** Voice waveform, one byte per sample (<= 256). */
	readonly waveform?: Uint8Array;
}

/** Options of {@link Outbox.sendMedia}. */
export interface SendMediaOptions {
	/** Caption. */
	readonly text?: string;
	readonly entities?: readonly MessageEntity[];
	readonly replyToSeq?: number;
	readonly randomId?: number;
	/** Forum groups: the topic (0 = General). */
	readonly topicId?: number;
	readonly silent?: boolean;
}

/** One file of an album. */
export interface AlbumItemInput {
	readonly file: Blob;
	readonly media: MediaInput;
	readonly text?: string;
	readonly entities?: readonly MessageEntity[];
	readonly randomId?: number;
}

/** Options of {@link Outbox.sendAlbum}. */
export interface SendAlbumOptions {
	readonly replyToSeq?: number;
	readonly topicId?: number;
	readonly silent?: boolean;
}

/** Most bytes of a client-made inline thumbnail and of a waveform the server accepts. */
export const INLINE_THUMB_MAX = 2048;
export const WAVEFORM_MAX = 256;

/** Options of {@link Outbox.sendText}. */
export interface SendTextOptions {
	readonly entities?: readonly MessageEntity[];
	readonly replyToSeq?: number;
	/** Idempotency key for a caller that may repeat the request. */
	readonly randomId?: number;
	/** Send without a link preview (the sender dismissed it). */
	readonly noLinkPreview?: boolean;
}

/** A message that is written locally and not yet confirmed by the server. */
export interface PendingMessage {
	readonly outboxId: number;
	readonly chatId: number;
	/** Stable render key: the confirmed message carries the same random_id. */
	readonly randomId: number;
	readonly text: string;
	readonly entities: readonly MessageEntity[];
	readonly replyToSeq: number;
	readonly date: number;
	/** Set when the server refused the message; it waits for retry or discard. */
	readonly failure: string | null;
	/**
	 * Fractional position after the newest real seq, so pending messages sort
	 * after confirmed ones and never collide with a real seq.
	 */
	readonly localSeq: number;
	/** Media sends: the file being uploaded. */
	readonly media?: PendingMedia;
	/** Album items: the outbox id shared by the album's messages. */
	readonly albumId?: number;
}

export interface OutboxOptions {
	readonly repo: Repository;
	readonly api: RemoteApi;
	readonly engine: SyncEngine;
	readonly timers: Timers;
	readonly selfId: number;
	readonly randomId: () => number;
	readonly random?: () => number;
	readonly backoff?: BackoffPolicy;
	/** Upper bound on message text, in code points (AppConfig.message_length_max). */
	readonly maxTextLength?: number;
	/** Upper bound on a caption, in code points (AppConfig.caption_length_max). */
	readonly maxCaptionLength?: number;
	/** Media sends wait for these uploads; without them sendMedia is refused. */
	readonly uploads?: UploadQueue;
	/** After a media send is confirmed: the uploaded file can move into the media cache. */
	readonly afterMediaSent?: (uploadKey: string, message: Message) => Promise<void>;
	readonly onSessionEnded: () => void;
	readonly onError?: (error: unknown, context: string) => void;
}

export class OutboxError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OutboxError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Decodes an outbox payload; null when the row is corrupt. */
export function parseOperation(kind: string, payload: string): OutboxOperation | null {
	let value: unknown;
	try {
		value = JSON.parse(payload) as unknown;
	} catch {
		return null;
	}
	if (!isRecord(value)) return null;
	switch (kind) {
		case "send": {
			const entities = decodeEntities(value.entities);
			if (typeof value.text !== "string" || entities === null) return null;
			if (!isNumber(value.replyToSeq) || !isNumber(value.date)) return null;
			// Rows queued before noLinkPreview existed keep the preview.
			return {
				kind,
				text: value.text,
				entities,
				replyToSeq: value.replyToSeq,
				date: value.date,
				noLinkPreview: value.noLinkPreview === true,
			};
		}
		case "edit": {
			const entities = decodeEntities(value.entities);
			if (!isNumber(value.seq) || typeof value.text !== "string" || entities === null) return null;
			return { kind, seq: value.seq, text: value.text, entities };
		}
		case "delete": {
			const seqs = value.seqs;
			if (!Array.isArray(seqs) || !seqs.every(isNumber) || typeof value.forEveryone !== "boolean") return null;
			return { kind, seqs, forEveryone: value.forEveryone };
		}
		case "read":
			return isNumber(value.maxSeq) ? { kind, maxSeq: value.maxSeq } : null;
		case "send_media": {
			const entities = decodeEntities(value.entities);
			const media = decodePendingMedia(value.media);
			if (typeof value.text !== "string" || entities === null || media === null) return null;
			if (!isNumber(value.replyToSeq) || !isNumber(value.date) || !isNumber(value.topicId)) return null;
			return {
				kind,
				text: value.text,
				entities,
				replyToSeq: value.replyToSeq,
				date: value.date,
				topicId: value.topicId,
				silent: value.silent === true,
				media,
			};
		}
		case "send_album": {
			if (!Array.isArray(value.items) || !isNumber(value.replyToSeq) || !isNumber(value.date) || !isNumber(value.topicId)) {
				return null;
			}
			const items: AlbumOperationItem[] = [];
			for (const raw of value.items as unknown[]) {
				if (!isRecord(raw)) return null;
				const entities = decodeEntities(raw.entities);
				const media = decodePendingMedia(raw.media);
				if (!isNumber(raw.randomId) || typeof raw.text !== "string" || entities === null || media === null) return null;
				items.push({ randomId: raw.randomId, text: raw.text, entities, media });
			}
			return { kind, replyToSeq: value.replyToSeq, date: value.date, topicId: value.topicId, silent: value.silent === true, items };
		}
		default:
			return null;
	}
}

const MEDIA_KINDS = new Set<string>(["photo", "video", "audio", "voice", "document"]);

function decodePendingMedia(value: unknown): PendingMedia | null {
	if (!isRecord(value)) return null;
	const { uploadKey, kind, fileName, mimeType, size, width, height, duration, inlineThumb } = value;
	if (typeof uploadKey !== "string" || typeof kind !== "string" || !MEDIA_KINDS.has(kind)) return null;
	if (typeof fileName !== "string" || typeof mimeType !== "string" || typeof inlineThumb !== "string") return null;
	if (!isNumber(size) || !isNumber(width) || !isNumber(height) || !isNumber(duration)) return null;
	return {
		uploadKey,
		kind: kind as MediaKind,
		fileName,
		mimeType,
		size,
		width,
		height,
		duration,
		inlineThumb: fromBase64(inlineThumb) ?? new Uint8Array(),
	};
}

function pendingMediaJson(media: PendingMedia): Record<string, unknown> {
	return { ...media, inlineThumb: toBase64(media.inlineThumb) };
}

function payloadOf(operation: OutboxOperation): string {
	switch (operation.kind) {
		case "send_media": {
			const { kind: _kind, media, ...rest } = operation;
			return JSON.stringify({ ...rest, media: pendingMediaJson(media) });
		}
		case "send_album": {
			const { kind: _kind, items, ...rest } = operation;
			return JSON.stringify({ ...rest, items: items.map((item) => ({ ...item, media: pendingMediaJson(item.media) })) });
		}
		default: {
			const { kind: _kind, ...rest } = operation;
			return JSON.stringify(rest);
		}
	}
}

/** Upload keys an operation waits for. */
export function uploadKeysOf(operation: OutboxOperation): string[] {
	switch (operation.kind) {
		case "send_media":
			return [operation.media.uploadKey];
		case "send_album":
			return operation.items.map((item) => item.media.uploadKey);
		default:
			return [];
	}
}

type Outcome = "done" | "retry_later" | "stopped";

export class Outbox {
	private running = false;
	private readonly active = new Set<number>();
	private readonly again = new Set<number>();
	private readonly retryTimers = new Map<number, unknown>();
	private readonly random: () => number;
	private readonly backoff: BackoffPolicy;

	constructor(private readonly options: OutboxOptions) {
		this.random = options.random ?? Math.random;
		this.backoff = options.backoff ?? DEFAULT_BACKOFF;
	}

	get busy(): boolean {
		return this.active.size > 0 || this.retryTimers.size > 0;
	}

	async start(): Promise<void> {
		this.running = true;
		await this.retryNow();
	}

	stop(): void {
		this.running = false;
		for (const handle of this.retryTimers.values()) this.options.timers.clearTimeout(handle);
		this.retryTimers.clear();
	}

	/** Skips backoff waits and runs every chat with work (on reconnect or network back). */
	async retryNow(): Promise<void> {
		if (!this.running) return;
		for (const handle of this.retryTimers.values()) this.options.timers.clearTimeout(handle);
		this.retryTimers.clear();
		const rows = await this.options.repo.driver.query("SELECT DISTINCT chat_id FROM outbox WHERE failure IS NULL");
		for (const row of rows) {
			const chatId = row.chat_id;
			if (typeof chatId === "number") this.kick(chatId);
		}
	}

	// ------------------------------------------------------------ operations

	/**
	 * Queues a text message. `randomId` lets a caller that may repeat the
	 * request (another tab re-sending after a leader handover) keep it
	 * idempotent; returns null when that random_id was already confirmed.
	 */
	async sendText(
		chatId: number,
		text: string,
		options: SendTextOptions = {},
	): Promise<PendingMessage | null> {
		assertSafeId(chatId);
		const entities = options.entities ?? [];
		const replyToSeq = assertSafeId(options.replyToSeq ?? 0);
		this.checkText(text, entities);
		const randomId = options.randomId === undefined ? this.options.randomId() : assertSafeId(options.randomId);
		if (randomId === 0) throw new OutboxError("random_id must not be 0");
		const date = Math.floor(this.options.timers.now() / 1000);
		const operation: OutboxOperation = {
			kind: "send",
			text,
			entities,
			replyToSeq,
			date,
			noLinkPreview: options.noLinkPreview === true,
		};
		let confirmed = false;
		await this.options.engine.commitLocal(async (w) => {
			const seen = await this.options.repo.driver.query(
				`SELECT 'outbox' AS place FROM outbox WHERE kind = 'send' AND chat_id = ?1 AND random_id = ?2
				UNION ALL SELECT 'messages' FROM messages WHERE chat_id = ?1 AND random_id = ?2`,
				[chatId, randomId],
			);
			confirmed = seen.some((row) => row.place === "messages");
			if (seen.length === 0) this.insert(w, chatId, operation, randomId);
		});
		if (confirmed) return null;
		// Read back before kicking the queue: once sent, the row is gone.
		const pending = (await this.pendingMessages(chatId)).find((p) => p.randomId === randomId) ?? null;
		this.kick(chatId);
		if (pending !== null) return pending;
		// A repeated request whose first copy was confirmed in the meantime.
		const sent = await this.options.repo.driver.query("SELECT 1 FROM messages WHERE chat_id = ? AND random_id = ?", [
			chatId,
			randomId,
		]);
		if (sent.length > 0) return null;
		throw new OutboxError("pending message vanished before it was read back");
	}

	/**
	 * Queues a file with an optional caption: the pending message shows at
	 * once (with the local thumbnail), the upload starts, and the send goes
	 * out in chat order once the upload completed. Returns null when
	 * `randomId` was already confirmed.
	 */
	async sendMedia(chatId: number, file: Blob, input: MediaInput, options: SendMediaOptions = {}): Promise<PendingMessage | null> {
		const uploads = this.requireUploads();
		assertSafeId(chatId);
		const text = options.text ?? "";
		const entities = options.entities ?? [];
		this.checkCaption(text, entities);
		const randomId = options.randomId === undefined ? this.options.randomId() : assertSafeId(options.randomId);
		if (randomId === 0) throw new OutboxError("random_id must not be 0");
		const media = this.pendingMedia(String(randomId), file, input);
		const operation: OutboxOperation = {
			kind: "send_media",
			text,
			entities,
			replyToSeq: assertSafeId(options.replyToSeq ?? 0),
			date: Math.floor(this.options.timers.now() / 1000),
			topicId: assertSafeId(options.topicId ?? 0),
			silent: options.silent === true,
			media,
		};
		let confirmed = false;
		let queued = false;
		await this.options.engine.commitLocal(async (w) => {
			const seen = await this.seen(chatId, [randomId]);
			confirmed = seen.confirmed;
			if (seen.any) return;
			await uploads.prepare(this.uploadSpec(media, input), file, w, this.options.timers.now());
			this.insert(w, chatId, operation, randomId);
			queued = true;
		});
		if (confirmed) return null;
		if (queued) uploads.schedule(media.uploadKey);
		const pending = (await this.pendingMessages(chatId)).find((p) => p.randomId === randomId) ?? null;
		this.kick(chatId);
		if (pending !== null) return pending;
		const sent = await this.options.repo.driver.query("SELECT 1 FROM messages WHERE chat_id = ? AND random_id = ?", [
			chatId,
			randomId,
		]);
		if (sent.length > 0) return null;
		throw new OutboxError("pending message vanished before it was read back");
	}

	/**
	 * Queues 2 or more files sent together (one album, captions per item).
	 * The caller checks the album rules (size, mix of kinds); the server
	 * enforces them too. Returns the pending messages, in order.
	 */
	async sendAlbum(chatId: number, inputs: readonly AlbumItemInput[], options: SendAlbumOptions = {}): Promise<PendingMessage[]> {
		const uploads = this.requireUploads();
		assertSafeId(chatId);
		if (inputs.length < 2) throw new OutboxError("an album needs at least 2 files");
		const items: AlbumOperationItem[] = inputs.map((input) => {
			const text = input.text ?? "";
			const entities = input.entities ?? [];
			this.checkCaption(text, entities);
			const randomId = input.randomId === undefined ? this.options.randomId() : assertSafeId(input.randomId);
			if (randomId === 0) throw new OutboxError("random_id must not be 0");
			return { randomId, text, entities, media: this.pendingMedia(String(randomId), input.file, input.media) };
		});
		if (new Set(items.map((i) => i.randomId)).size !== items.length) throw new OutboxError("album random_ids must differ");
		const first = items[0]?.randomId ?? 0;
		const operation: OutboxOperation = {
			kind: "send_album",
			replyToSeq: assertSafeId(options.replyToSeq ?? 0),
			date: Math.floor(this.options.timers.now() / 1000),
			topicId: assertSafeId(options.topicId ?? 0),
			silent: options.silent === true,
			items,
		};
		let queued = false;
		await this.options.engine.commitLocal(async (w) => {
			const seen = await this.seen(chatId, items.map((i) => i.randomId));
			if (seen.any) return;
			for (const [index, item] of items.entries()) {
				const input = inputs[index];
				if (input === undefined) continue;
				await uploads.prepare(this.uploadSpec(item.media, input.media), input.file, w, this.options.timers.now());
			}
			this.insert(w, chatId, operation, first);
			queued = true;
		});
		if (queued) for (const item of items) uploads.schedule(item.media.uploadKey);
		const keys = new Set(items.map((i) => i.randomId));
		const pending = (await this.pendingMessages(chatId)).filter((p) => keys.has(p.randomId));
		this.kick(chatId);
		return pending;
	}

	private requireUploads(): UploadQueue {
		const uploads = this.options.uploads;
		if (uploads === undefined) throw new OutboxError("sending media is not available");
		return uploads;
	}

	/** Whether any of the random_ids is queued or confirmed in the chat, and whether one is confirmed. */
	private async seen(chatId: number, randomIds: readonly number[]): Promise<{ any: boolean; confirmed: boolean }> {
		const list = randomIds.map(() => "?").join(", ");
		const rows = await this.options.repo.driver.query(
			`SELECT 'messages' AS place FROM messages WHERE chat_id = ? AND random_id IN (${list})
			UNION ALL SELECT 'outbox' FROM outbox WHERE chat_id = ? AND kind IN ('send_media', 'send_album') AND random_id IN (${list})`,
			[chatId, ...randomIds, chatId, ...randomIds],
		);
		return { any: rows.length > 0, confirmed: rows.some((row) => row.place === "messages") };
	}

	private pendingMedia(uploadKey: string, file: Blob, input: MediaInput): PendingMedia {
		if (file.size <= 0) throw new OutboxError("the file is empty");
		const thumb = input.inlineThumb ?? new Uint8Array();
		if (thumb.length > INLINE_THUMB_MAX) throw new OutboxError(`inline thumbnail is larger than ${INLINE_THUMB_MAX} bytes`);
		if ((input.waveform?.length ?? 0) > WAVEFORM_MAX) throw new OutboxError(`waveform is longer than ${WAVEFORM_MAX} samples`);
		const blobName = (file as Blob & { name?: unknown }).name;
		return {
			uploadKey,
			kind: input.kind,
			fileName: input.fileName ?? (typeof blobName === "string" ? blobName : ""),
			mimeType: input.mimeType ?? file.type,
			size: file.size,
			width: Math.max(0, Math.round(input.width ?? 0)),
			height: Math.max(0, Math.round(input.height ?? 0)),
			duration: Math.max(0, Math.round(input.duration ?? 0)),
			inlineThumb: thumb,
		};
	}

	private uploadSpec(media: PendingMedia, input: MediaInput): UploadSpec {
		return {
			key: media.uploadKey,
			kind: media.kind,
			fileName: media.fileName,
			mimeType: media.mimeType,
			size: media.size,
			width: media.width,
			height: media.height,
			duration: media.duration,
			inlineThumb: media.inlineThumb,
			waveform: input.waveform ?? new Uint8Array(),
		};
	}

	async editText(chatId: number, seq: number, text: string, entities: readonly MessageEntity[] = []): Promise<void> {
		assertSafeId(chatId);
		assertSafeId(seq);
		this.checkText(text, entities);
		const message = await this.options.repo.message(chatId, seq);
		if (message === null) throw new OutboxError(`message ${chatId}/${seq} is not cached`);
		await this.options.engine.commitLocal((w) => {
			const edited = { ...message, text, entities };
			w.add("UPDATE messages SET text = ?, entities = ?, search_text = ? WHERE chat_id = ? AND seq = ?", [
				text,
				JSON.stringify(entities),
				messageSearchText(edited),
				chatId,
				seq,
			]);
			w.emit(EventKeys.message(chatId, seq));
			this.insert(w, chatId, { kind: "edit", seq, text, entities }, 0);
		});
		this.kick(chatId);
	}

	async deleteMessages(chatId: number, seqs: readonly number[], forEveryone: boolean): Promise<void> {
		assertSafeId(chatId);
		const list = [...new Set(seqs.map(assertSafeId))];
		if (list.length === 0) return;
		await this.options.engine.commitLocal((w) => {
			// Recalled messages keep a placeholder, like on every other device.
			if (forEveryone) recallMessages(w, chatId, list, this.options.selfId);
			else purgeMessages(w, chatId, list, this.options.selfId);
			this.insert(w, chatId, { kind: "delete", seqs: list, forEveryone }, 0);
		});
		this.kick(chatId);
	}

	/**
	 * Marks the chat read up to maxSeq; later marks replace earlier unsent
	 * ones. A chat marked as unread loses the mark even when the position
	 * does not move (the server clears it with the read).
	 */
	async markRead(chatId: number, maxSeq: number): Promise<void> {
		assertSafeId(chatId);
		assertSafeId(maxSeq);
		await this.options.engine.commitLocal(async (w) => {
			const dialog = await this.options.repo.dialog(chatId);
			if (dialog === null || (dialog.readInboxMaxSeq >= maxSeq && !dialog.unreadMark) || maxSeq === 0) return;
			if (dialog.unreadMark) putUnreadMark(w, chatId, false);
			if (dialog.readInboxMaxSeq < maxSeq) {
				const { repo, selfId } = this.options;
				const unread = await repo.countIncomingAfter(chatId, maxSeq, selfId);
				const mentions = unread === 0 ? 0 : await repo.countMentionsAfter(chatId, maxSeq, selfId);
				putLocalRead(w, chatId, maxSeq, unread, mentions);
			}
			w.add("DELETE FROM outbox WHERE chat_id = ? AND kind = 'read' AND failure IS NULL", [chatId]);
			this.insert(w, chatId, { kind: "read", maxSeq }, 0);
		});
		this.kick(chatId);
	}

	async retry(outboxId: number): Promise<void> {
		const row = (await this.options.repo.outbox()).find((item) => item.id === outboxId);
		if (row === undefined) return;
		await this.options.engine.commitLocal((w) => {
			w.add("UPDATE outbox SET failure = NULL, attempts = 0 WHERE id = ?", [outboxId]);
			w.emit(EventKeys.outbox, EventKeys.history(row.chatId));
		});
		this.kick(row.chatId);
	}

	async discard(outboxId: number): Promise<void> {
		const row = (await this.options.repo.outbox()).find((item) => item.id === outboxId);
		if (row === undefined) return;
		await this.options.engine.commitLocal((w) => {
			w.add("DELETE FROM outbox WHERE id = ?", [outboxId]);
			w.emit(EventKeys.outbox, EventKeys.history(row.chatId));
		});
		const operation = parseOperation(row.kind, row.payload);
		const keys = operation === null ? [] : uploadKeysOf(operation);
		if (keys.length > 0) await this.options.uploads?.remove(keys);
	}

	/** Upload keys of every queued operation (to drop uploads whose send is gone). */
	async uploadKeys(): Promise<Set<string>> {
		const keys = new Set<string>();
		for (const row of await this.options.repo.outbox()) {
			const operation = parseOperation(row.kind, row.payload);
			if (operation !== null) for (const key of uploadKeysOf(operation)) keys.add(key);
		}
		return keys;
	}

	/** Pending sends of a chat, in send order, positioned after the newest real seq. */
	async pendingMessages(chatId: number): Promise<PendingMessage[]> {
		const rows = (await this.options.repo.outbox(chatId)).filter(
			(row) => row.kind === "send" || row.kind === "send_media" || row.kind === "send_album",
		);
		if (rows.length === 0) return [];
		const top = await this.options.repo.maxSeq(chatId);
		type Entry = Omit<PendingMessage, "localSeq">;
		const entries: Entry[] = [];
		for (const row of rows) {
			const operation = parseOperation(row.kind, row.payload);
			const base = { outboxId: row.id, chatId, failure: row.failure };
			switch (operation?.kind) {
				case "send":
					entries.push({
						...base,
						randomId: row.randomId,
						text: operation.text,
						entities: operation.entities,
						replyToSeq: operation.replyToSeq,
						date: operation.date,
					});
					break;
				case "send_media":
					entries.push({
						...base,
						randomId: row.randomId,
						text: operation.text,
						entities: operation.entities,
						replyToSeq: operation.replyToSeq,
						date: operation.date,
						media: operation.media,
					});
					break;
				case "send_album":
					for (const item of operation.items) {
						entries.push({
							...base,
							randomId: item.randomId,
							text: item.text,
							entities: item.entities,
							replyToSeq: operation.replyToSeq,
							date: operation.date,
							media: item.media,
							albumId: row.id,
						});
					}
					break;
				default:
			}
		}
		return entries.map((entry, index) => ({ ...entry, localSeq: top + (index + 1) / (entries.length + 1) }));
	}

	// ------------------------------------------------------------- execution

	private checkText(text: string, entities: readonly MessageEntity[]): void {
		if (text.trim() === "") throw new OutboxError("message text is empty");
		const max = this.options.maxTextLength;
		if (max !== undefined && codePointLength(text) > max) {
			throw new OutboxError(`message text is longer than ${max} characters`);
		}
		const errors = validateEntities(text, entities);
		if (errors.length > 0) throw new OutboxError(`invalid entity #${errors[0]?.index ?? 0}: ${errors[0]?.code ?? ""}`);
	}

	private checkCaption(text: string, entities: readonly MessageEntity[]): void {
		const max = this.options.maxCaptionLength;
		if (max !== undefined && codePointLength(text) > max) throw new OutboxError(`caption is longer than ${max} characters`);
		const errors = validateEntities(text, entities);
		if (errors.length > 0) throw new OutboxError(`invalid entity #${errors[0]?.index ?? 0}: ${errors[0]?.code ?? ""}`);
	}

	private insert(w: WriteBatch, chatId: number, operation: OutboxOperation, randomId: number): void {
		w.add("INSERT INTO outbox (chat_id, kind, random_id, payload, created_at) VALUES (?, ?, ?, ?, ?)", [
			chatId,
			operation.kind,
			randomId,
			payloadOf(operation),
			this.options.timers.now(),
		]);
		w.emit(EventKeys.outbox, EventKeys.history(chatId));
	}

	private kick(chatId: number): void {
		if (!this.running) return;
		if (this.active.has(chatId)) {
			this.again.add(chatId);
			return;
		}
		const timer = this.retryTimers.get(chatId);
		if (timer !== undefined) this.options.timers.clearTimeout(timer);
		this.retryTimers.delete(chatId);
		this.active.add(chatId);
		void this.drain(chatId);
	}

	private async drain(chatId: number): Promise<void> {
		try {
			for (;;) {
				this.again.delete(chatId);
				if (!this.running) return;
				const head = (await this.options.repo.outbox(chatId)).find((row) => row.failure === null);
				if (head === undefined) return;
				const outcome = await this.execute(head);
				if (outcome === "stopped") return;
				if (outcome === "retry_later") {
					this.scheduleRetry(chatId, head.attempts);
					return;
				}
			}
		} catch (err) {
			// Local database failure: report and try again later.
			this.options.onError?.(err, `outbox ${chatId}`);
			this.scheduleRetry(chatId, 0);
		} finally {
			this.active.delete(chatId);
			if (this.again.has(chatId) && !this.retryTimers.has(chatId)) this.kick(chatId);
		}
	}

	private scheduleRetry(chatId: number, attempts: number): void {
		if (!this.running || this.retryTimers.has(chatId)) return;
		const handle = this.options.timers.setTimeout(() => {
			this.retryTimers.delete(chatId);
			this.kick(chatId);
		}, backoffDelay(attempts, this.backoff, this.random));
		this.retryTimers.set(chatId, handle);
	}

	private async execute(row: OutboxRow): Promise<Outcome> {
		const operation = parseOperation(row.kind, row.payload);
		if (operation === null) {
			await this.markFailed(row, "corrupt outbox entry");
			return "done";
		}
		try {
			await this.perform(row, operation);
			return "done";
		} catch (err) {
			switch (classifyFailure(err)) {
				case "unauthenticated":
					this.running = false;
					this.options.onSessionEnded();
					return "stopped";
				case "retryable":
					await this.options.engine.commitLocal((w) => {
						w.add("UPDATE outbox SET attempts = attempts + 1 WHERE id = ?", [row.id]);
					});
					return "retry_later";
				case "permanent":
					this.options.onError?.(err, `outbox ${row.kind} ${row.chatId}`);
					await this.markFailed(row, err instanceof Error ? err.message : String(err));
					return "done";
			}
		}
	}

	private async markFailed(row: OutboxRow, failure: string): Promise<void> {
		await this.options.engine.commitLocal((w) => {
			w.add("UPDATE outbox SET failure = ? WHERE id = ?", [failure, row.id]);
			w.emit(EventKeys.outbox, EventKeys.history(row.chatId));
		});
	}

	private async perform(row: OutboxRow, operation: OutboxOperation): Promise<void> {
		const { api, engine, selfId } = this.options;
		const chatId = toWireId(row.chatId);
		const finish = (w: WriteBatch): void => {
			w.add("DELETE FROM outbox WHERE id = ?", [row.id]);
			w.emit(EventKeys.outbox, EventKeys.history(row.chatId));
		};
		let ack: SyncAck | null;
		switch (operation.kind) {
			case "send": {
				const response = await api.messages.sendMessage({
					chatId,
					text: operation.text,
					entities: operation.entities.flatMap((e) => toWireEntity(e) ?? []),
					replyToSeq: toWireId(operation.replyToSeq),
					randomId: toWireId(row.randomId),
					silent: false,
					noLinkPreview: operation.noLinkPreview,
				});
				if (response.message === undefined) throw new OutboxError("SendMessage returned no message");
				const message = toMessage(response.message);
				ack = toSyncAck(response.ack);
				await engine.commitMutation(
					row.chatId,
					(w) => {
						putNewMessage(w, message, selfId);
						finish(w);
					},
					ack,
				);
				return;
			}
			case "edit": {
				const response = await api.messages.editMessage({
					chatId,
					seq: toWireId(operation.seq),
					text: operation.text,
					entities: operation.entities.flatMap((e) => toWireEntity(e) ?? []),
				});
				const edited = response.message === undefined ? null : toMessage(response.message);
				await engine.commitMutation(
					row.chatId,
					(w) => {
						if (edited !== null) putMessage(w, edited);
						finish(w);
					},
					toSyncAck(response.ack),
				);
				return;
			}
			case "delete": {
				const response = await api.messages.deleteMessages({
					chatId,
					seqs: operation.seqs.map(toWireId),
					forEveryone: operation.forEveryone,
				});
				await engine.commitMutation(row.chatId, finish, toSyncAck(response.ack));
				return;
			}
			case "read": {
				const response = await api.messages.readHistory({ chatId, maxSeq: toWireId(operation.maxSeq) });
				await engine.commitMutation(row.chatId, finish, toSyncAck(response.ack));
				return;
			}
			case "send_media": {
				const sendMedia = api.messages.sendMedia;
				const uploads = this.options.uploads;
				if (sendMedia === undefined || uploads === undefined) throw new OutboxError("sending media is not available");
				const media = await uploads.waitFor(operation.media.uploadKey);
				const response = await sendMedia({
					chatId,
					fileId: media.fileId,
					text: operation.text,
					entities: operation.entities.flatMap((e) => toWireEntity(e) ?? []),
					replyToSeq: toWireId(operation.replyToSeq),
					randomId: toWireId(row.randomId),
					silent: operation.silent,
					topicId: toWireId(operation.topicId),
				});
				if (response.message === undefined) throw new OutboxError("SendMedia returned no message");
				const message = toMessage(response.message);
				await engine.commitMutation(
					row.chatId,
					(w) => {
						putNewMessage(w, message, selfId);
						finish(w);
					},
					toSyncAck(response.ack),
				);
				await this.mediaSent(operation.media.uploadKey, message);
				return;
			}
			case "send_album": {
				const sendAlbum = api.messages.sendAlbum;
				const uploads = this.options.uploads;
				if (sendAlbum === undefined || uploads === undefined) throw new OutboxError("sending media is not available");
				const files: MediaRef[] = [];
				for (const item of operation.items) files.push(await uploads.waitFor(item.media.uploadKey));
				const response = await sendAlbum({
					chatId,
					items: operation.items.map((item, index) => ({
						fileId: files[index]?.fileId ?? "",
						text: item.text,
						entities: item.entities.flatMap((e) => toWireEntity(e) ?? []),
						randomId: toWireId(item.randomId),
					})),
					replyToSeq: toWireId(operation.replyToSeq),
					silent: operation.silent,
					topicId: toWireId(operation.topicId),
				});
				const messages = response.messages.map(toMessage);
				await engine.commitMutation(
					row.chatId,
					(w) => {
						for (const message of messages) putNewMessage(w, message, selfId);
						finish(w);
					},
					toSyncAck(response.ack),
				);
				for (const [index, item] of operation.items.entries()) {
					const message = messages[index];
					if (message !== undefined) await this.mediaSent(item.media.uploadKey, message);
				}
				return;
			}
		}
	}

	/** Hands a confirmed upload's file over (media cache), then forgets the upload. */
	private async mediaSent(uploadKey: string, message: Message): Promise<void> {
		try {
			await this.options.afterMediaSent?.(uploadKey, message);
		} catch (err) {
			this.options.onError?.(err, `media sent ${uploadKey}`);
		}
		try {
			await this.options.uploads?.remove([uploadKey], false);
		} catch (err) {
			this.options.onError?.(err, `drop upload ${uploadKey}`);
		}
	}
}
