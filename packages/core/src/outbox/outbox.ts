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
import type { MessageEntity, SyncAck } from "../model/types.ts";
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
	| { readonly kind: "read"; readonly maxSeq: number };

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
		default:
			return null;
	}
}

function payloadOf(operation: OutboxOperation): string {
	const { kind: _kind, ...rest } = operation;
	return JSON.stringify(rest);
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
				const unread = await this.options.repo.countIncomingAfter(chatId, maxSeq, this.options.selfId);
				putLocalRead(w, chatId, maxSeq, unread);
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
	}

	/** Pending sends of a chat, in send order, positioned after the newest real seq. */
	async pendingMessages(chatId: number): Promise<PendingMessage[]> {
		const rows = (await this.options.repo.outbox(chatId)).filter((row) => row.kind === "send");
		if (rows.length === 0) return [];
		const top = await this.options.repo.maxSeq(chatId);
		const pending: PendingMessage[] = [];
		rows.forEach((row, index) => {
			const operation = parseOperation(row.kind, row.payload);
			if (operation?.kind !== "send") return;
			pending.push({
				outboxId: row.id,
				chatId,
				randomId: row.randomId,
				text: operation.text,
				entities: operation.entities,
				replyToSeq: operation.replyToSeq,
				date: operation.date,
				failure: row.failure,
				localSeq: top + (index + 1) / (rows.length + 1),
			});
		});
		return pending;
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
		}
	}
}
