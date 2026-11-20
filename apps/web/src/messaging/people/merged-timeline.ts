// The merged timeline of a person (ADR 0025): the messages of the caller's
// private chats with every identity of the person, in one chronological
// list, without copying them anywhere. Each chat has its own buffer outside
// the store's windows (those trim and stop being live when scrolled back),
// opened from the newest message and never trimmed. What is shown lies
// between the newest message of any chat (buffers follow live updates) and
// the old bound (merged-order.ts). Loads of one chat run one after another,
// so a page never lands on a buffer another load has just replaced.
import { EventKeys, type FailureKind, type HistoryRequest, type HistoryView } from "@achoo254/chat-core";
import type { ChatSource } from "../data/source.ts";
import type { PersonMember } from "./people-api.ts";
import {
	anyHoldsBound,
	applyNewest,
	applyOlder,
	applyOne,
	boundHolders,
	mergeItems,
	newBuffer,
	type ChatBuffer,
	type MergedItem,
} from "./merged-order.ts";

export type { MergedItem } from "./merged-order.ts";

/** The part of the data source the timeline reads. */
export type TimelineSource = Pick<ChatSource, "events" | "history" | "connectionState">;

export interface MergedTimelineOptions {
	readonly source: TimelineSource;
	/** The person's identities; those without a private chat (chatId 0) are skipped. */
	readonly members: readonly Pick<PersonMember, "chatId" | "app">[];
	/** Messages per page (default 30). */
	readonly pageSize?: number;
	readonly onError?: (error: unknown, context: string) => void;
}

export interface MergedTimelineSnapshot {
	/** "loading" until every chat's newest page arrived or failed. */
	readonly status: "loading" | "ready";
	/** Oldest first; pending sends last. */
	readonly items: readonly MergedItem[];
	/** Some chat has history older than what is shown. */
	readonly hasOlder: boolean;
	readonly loadingOlder: boolean;
	/** Chats whose last load failed; the others still show. */
	readonly failures: ReadonlyMap<number, FailureKind>;
}

const DEFAULT_PAGE = 30;

/** One chat with its serialised loads and the changes waiting for the next sync. */
interface ChatSync {
	readonly buffer: ChatBuffer;
	queue: Promise<void>;
	newest: boolean;
	readonly seqs: Set<number>;
	queued: boolean;
}

export class MergedTimeline {
	private readonly source: TimelineSource;
	private readonly pageSize: number;
	private readonly onError: (error: unknown, context: string) => void;
	private readonly chats = new Map<number, ChatSync>();
	private readonly listeners = new Set<() => void>();
	private state: MergedTimelineSnapshot;
	private byKey = new Map<string, MergedItem>();
	private olderRun: Promise<void> | null = null;
	private unsubscribe: (() => void) | null = null;
	private connected: boolean | null = null;
	private connectionReads = 0;
	private opened = false;
	private disposed = false;

	constructor(options: MergedTimelineOptions) {
		this.source = options.source;
		this.pageSize = options.pageSize ?? DEFAULT_PAGE;
		this.onError = options.onError ?? (() => undefined);
		for (const member of options.members) {
			if (member.chatId === 0 || this.chats.has(member.chatId)) continue;
			const buffer = newBuffer(member.chatId, member.app);
			this.chats.set(member.chatId, { buffer, queue: Promise.resolve(), newest: false, seqs: new Set(), queued: false });
		}
		const status = this.chats.size === 0 ? "ready" : "loading";
		this.state = { status, items: [], hasOlder: false, loadingOlder: false, failures: new Map() };
	}

	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	readonly snapshot = (): MergedTimelineSnapshot => this.state;

	/** Starts following the chats and loads the newest page of each. */
	open(): void {
		if (this.opened || this.disposed) return;
		this.opened = true;
		this.unsubscribe = this.source.events.subscribeBatches((keys) => this.onKeys(keys));
		for (const chat of this.chats.values()) this.request(chat, true, null);
		this.readConnection();
	}

	/** Loads one older page of the chats holding the old bound back; repeated calls join the running load. */
	loadOlder(): Promise<void> {
		if (!this.opened || this.disposed || this.state.status === "loading") return Promise.resolve();
		if (this.olderRun !== null) return this.olderRun;
		const holders = boundHolders(this.buffers());
		if (holders.length === 0) return Promise.resolve();
		this.setLoadingOlder(true);
		const loads = holders.map((buffer) => {
			const chat = this.chats.get(buffer.chatId);
			return chat === undefined ? Promise.resolve() : this.enqueue(chat, () => this.loadOlderOf(chat));
		});
		this.olderRun = Promise.all(loads).then(() => {
			this.olderRun = null;
			this.setLoadingOlder(false);
		});
		return this.olderRun;
	}

	/** Reads the newest page of every chat again (after a reconnect, or to retry a failure). */
	refresh(): Promise<void> {
		if (!this.opened || this.disposed) return Promise.resolve();
		for (const chat of this.chats.values()) this.request(chat, true, null);
		return Promise.all([...this.chats.values()].map((chat) => chat.queue)).then(() => undefined);
	}

	/** The newest message of `chatId` shown now (0: none); read receipts never go above it. */
	shownMaxSeq(chatId: number): number {
		let max = 0;
		for (const item of this.state.items) {
			if (item.kind === "message" && item.chatId === chatId && item.message.seq > max) max = item.message.seq;
		}
		return max;
	}

	/** Stops following the chats; loads still running are ignored when they end. */
	dispose(): void {
		this.disposed = true;
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.listeners.clear();
	}

	private buffers(): ChatBuffer[] {
		return [...this.chats.values()].map((chat) => chat.buffer);
	}

	/** The same keys the store follows: new or removed messages, one message changed, sends, the connection. */
	private onKeys(keys: readonly string[]): void {
		if (this.disposed) return;
		for (const key of keys) {
			const [kind, chatPart, seqPart] = key.split(":");
			if (key === EventKeys.outbox) {
				for (const chat of this.chats.values()) this.request(chat, true, null);
			} else if (key === EventKeys.connection) {
				this.readConnection();
			} else if (kind === "history" || kind === "message") {
				const chat = this.chats.get(Number(chatPart));
				if (chat === undefined) continue;
				if (kind === "history") this.request(chat, true, null);
				else this.request(chat, false, Number(seqPart));
			}
		}
	}

	private request(chat: ChatSync, newest: boolean, seq: number | null): void {
		if (newest) chat.newest = true;
		if (seq !== null && Number.isSafeInteger(seq) && seq > 0) chat.seqs.add(seq);
		if (chat.queued) return;
		chat.queued = true;
		void this.enqueue(chat, () => this.sync(chat));
	}

	/** Runs `task` after the chat's earlier loads, then shows the result. Never rejects. */
	private enqueue(chat: ChatSync, task: () => Promise<void>): Promise<void> {
		chat.queue = chat.queue
			.then(task)
			.catch((err: unknown) => this.report(err, `merged timeline ${chat.buffer.chatId}`))
			.then(() => this.publish());
		return chat.queue;
	}

	private async sync(chat: ChatSync): Promise<void> {
		chat.queued = false;
		const newest = chat.newest;
		const seqs = [...chat.seqs];
		chat.newest = false;
		chat.seqs.clear();
		// Messages at or above the newest page's oldest seq were just read again.
		const covered = newest ? await this.loadNewest(chat.buffer) : Infinity;
		for (const seq of seqs) {
			if (this.disposed) return;
			if (seq < covered && chat.buffer.messages.some((message) => message.seq === seq)) await this.loadOne(chat.buffer, seq);
		}
	}

	/**
	 * Reads the newest page; when it does not reach the buffered messages
	 * (updates missed while offline), keeps reading older pages until it does,
	 * so the buffer never has a hole. Returns the lowest seq read again.
	 */
	private async loadNewest(buffer: ChatBuffer): Promise<number> {
		const view = await this.fetch(buffer, { direction: "older", offsetSeq: 0, limit: this.pageSize });
		if (view === null) return Infinity;
		if (view.failure !== null && view.messages.length === 0) {
			buffer.failure = view.failure;
			return Infinity;
		}
		let fetched = [...view.messages];
		let hasOlder = view.hasOlder;
		const bufferedNewest = buffer.messages[buffer.messages.length - 1]?.seq ?? 0;
		let lowest = fetched[0]?.seq ?? 0;
		while (bufferedNewest > 0 && hasOlder && lowest > bufferedNewest + 1) {
			const page = await this.fetch(buffer, { direction: "older", offsetSeq: lowest, limit: this.pageSize });
			if (page === null) return Infinity;
			const below = page.messages.filter((message) => message.seq < lowest);
			if (below.length === 0) break;
			fetched = [...below, ...fetched];
			hasOlder = page.hasOlder;
			lowest = below[0]?.seq ?? lowest;
		}
		applyNewest(buffer, fetched, hasOlder, view.pending);
		buffer.failure = view.failure;
		return lowest;
	}

	private async loadOlderOf(chat: ChatSync): Promise<void> {
		const buffer = chat.buffer;
		const oldest = buffer.messages[0];
		if (oldest === undefined) {
			await this.loadNewest(buffer);
			return;
		}
		const view = await this.fetch(buffer, { direction: "older", offsetSeq: oldest.seq, limit: this.pageSize });
		if (view === null) return;
		applyOlder(buffer, view.messages, view.hasOlder);
		buffer.failure = view.failure;
	}

	/** One message changed (edit, reaction) or is gone (deleted). */
	private async loadOne(buffer: ChatBuffer, seq: number): Promise<void> {
		const view = await this.fetch(buffer, { direction: "around", offsetSeq: seq, limit: 1 });
		if (view === null) return;
		applyOne(buffer, seq, view.messages.find((message) => message.seq === seq) ?? null);
	}

	/** The page, or null when the read threw (the chat is marked failed) or the timeline was disposed. */
	private async fetch(buffer: ChatBuffer, request: HistoryRequest): Promise<HistoryView | null> {
		try {
			const view = await this.source.history(buffer.chatId, request);
			return this.disposed ? null : view;
		} catch (err) {
			if (this.disposed) return null;
			this.report(err, `history ${buffer.chatId}`);
			buffer.failure = "retryable";
			return null;
		}
	}

	/** Back online after being offline: updates may have been missed, so read every newest page again. */
	private readConnection(): void {
		const read = ++this.connectionReads;
		this.source.connectionState().then(
			(state) => {
				if (this.disposed || read !== this.connectionReads) return;
				const now = state === "connected";
				if (now && this.connected === false) void this.refresh();
				this.connected = now;
			},
			(err: unknown) => this.report(err, "connection state"),
		);
	}

	private setLoadingOlder(loadingOlder: boolean): void {
		if (this.disposed || this.state.loadingOlder === loadingOlder) return;
		this.state = { ...this.state, loadingOlder };
		this.notify();
	}

	private publish(): void {
		if (this.disposed) return;
		const buffers = this.buffers();
		const items = mergeItems(buffers, this.byKey);
		const status = buffers.some((buffer) => !buffer.loaded && buffer.failure === null) ? "loading" : "ready";
		const failures = new Map<number, FailureKind>();
		for (const buffer of buffers) if (buffer.failure !== null) failures.set(buffer.chatId, buffer.failure);
		const prev = this.state;
		const hasOlder = anyHoldsBound(buffers);
		const sameItems = items.length === prev.items.length && items.every((item, i) => item === prev.items[i]);
		const sameFailures = failures.size === prev.failures.size && [...failures].every(([id, kind]) => prev.failures.get(id) === kind);
		if (sameItems && sameFailures && status === prev.status && hasOlder === prev.hasOlder) return;
		this.byKey = new Map(items.map((item) => [item.key, item]));
		this.state = {
			status,
			items: sameItems ? prev.items : items,
			hasOlder,
			loadingOlder: prev.loadingOlder,
			failures: sameFailures ? prev.failures : failures,
		};
		this.notify();
	}

	private notify(): void {
		for (const listener of [...this.listeners]) listener();
	}

	private report(error: unknown, context: string): void {
		if (!this.disposed) this.onError(error, context);
	}
}
