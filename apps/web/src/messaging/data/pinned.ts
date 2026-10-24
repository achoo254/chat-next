// Pinned messages per chat and forum topic (mockups/chat.html#app pinned bar,
// #pin-message list), fetched from the server newest first: the core keeps
// only the newest pin and the count on the dialog. A list reloads when the
// dialog's pin count or newest pin changes (a pin, an unpin, a recall), when
// the core says the pins changed, or when a listed message is edited.
import { EventKeys, type Message } from "@achoo254/chat-core";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useServices } from "./services.tsx";
import type { ChatSource } from "./source.ts";
import type { ChatStore } from "./store.ts";

/** One page is enough for the bar and the list of almost every chat. */
const PAGE = 100;

export interface PinnedState {
	readonly status: "loading" | "ready" | "error";
	/** Newest first. */
	readonly messages: readonly Message[];
	/** Every pinned message the user can see (may exceed `messages`). */
	readonly count: number;
	readonly hasMore: boolean;
}

interface Entry {
	state: PinnedState;
	generation: number;
	loadingMore: boolean;
}

const LOADING: PinnedState = { status: "loading", messages: [], count: 0, hasMore: false };

const listKey = (chatId: number, topicId: number): string => `${chatId}:${topicId}`;

export class PinnedLists {
	private readonly lists = new Map<string, Entry>();
	private readonly listeners = new Map<string, Set<() => void>>();
	/** Per chat with a cached list: the dialog's pin count, newest pin and the chat's pinned seq. */
	private readonly watched = new Map<number, { signature: string }>();

	private readonly source: ChatSource;

	constructor(private readonly store: ChatStore) {
		this.source = store.source;
		// Lives as long as its store: the client's event bus ends with the session.
		this.store.source.events.subscribeBatches((keys) => {
			for (const key of keys) {
				const [kind, id, seq] = key.split(":");
				const chatId = Number(id);
				if (!this.watched.has(chatId)) continue;
				if (key === EventKeys.pins(chatId)) this.reloadChat(chatId);
				else if (kind === "message" && this.listed(chatId, Number(seq))) this.reloadChat(chatId);
			}
		});
	}

	/** The cached list, or undefined before `load`. */
	state(chatId: number, topicId: number): PinnedState | undefined {
		return this.lists.get(listKey(chatId, topicId))?.state;
	}

	/** Fetches the list once; later changes reload it on their own. */
	load(chatId: number, topicId: number): void {
		if (this.lists.has(listKey(chatId, topicId))) return;
		this.watch(chatId);
		void this.fetch(chatId, topicId);
	}

	/** Fetches the next page (the bar rotated past the loaded pins). */
	loadMore(chatId: number, topicId: number): void {
		const entry = this.lists.get(listKey(chatId, topicId));
		const last = entry?.state.messages.at(-1);
		if (entry === undefined || entry.loadingMore || !entry.state.hasMore || last === undefined) return;
		entry.loadingMore = true;
		const generation = entry.generation;
		this.source.pinnedMessages(chatId, { topicId, offsetSeq: last.seq, limit: PAGE }).then(
			(page) => {
				entry.loadingMore = false;
				if (generation !== entry.generation) return;
				const known = new Set(entry.state.messages.map((message) => message.seq));
				const messages = [...entry.state.messages, ...page.messages.filter((message) => !known.has(message.seq))];
				this.set(chatId, topicId, entry, { status: "ready", messages, count: page.count, hasMore: page.hasMore });
			},
			(err: unknown) => {
				entry.loadingMore = false;
				this.store.reportError(err, `pinned messages ${chatId}`);
			},
		);
	}

	/** Whether a cached list of the chat holds the message. */
	listed(chatId: number, seq: number): boolean {
		for (const [key, entry] of this.lists) {
			if (key.startsWith(`${chatId}:`) && entry.state.messages.some((message) => message.seq === seq)) return true;
		}
		return false;
	}

	/** Drops a message from the cached lists right away (the server's update reloads them). */
	forget(chatId: number, seqs: readonly number[] | "all"): void {
		for (const [key, entry] of this.lists) {
			if (!key.startsWith(`${chatId}:`)) continue;
			const topicId = Number(key.split(":")[1]);
			const kept = seqs === "all" ? [] : entry.state.messages.filter((message) => !seqs.includes(message.seq));
			const removed = entry.state.messages.length - kept.length;
			if (removed === 0) continue;
			this.set(chatId, topicId, entry, { ...entry.state, messages: kept, count: seqs === "all" ? 0 : Math.max(0, entry.state.count - removed) });
		}
	}

	subscribe(chatId: number, topicId: number, listener: () => void): () => void {
		const key = listKey(chatId, topicId);
		let set = this.listeners.get(key);
		if (set === undefined) {
			set = new Set();
			this.listeners.set(key, set);
		}
		set.add(listener);
		return () => {
			const current = this.listeners.get(key);
			current?.delete(listener);
			if (current?.size === 0) this.listeners.delete(key);
		};
	}

	private signature(chatId: number): string {
		const view = this.store.dialog(chatId);
		const chat = this.store.chat(chatId);
		return `${view?.dialog.pinnedMessageCount ?? 0}:${view?.dialog.pinnedMessageSeq ?? 0}:${chat?.pinnedSeq ?? 0}`;
	}

	private watch(chatId: number): void {
		if (this.watched.has(chatId)) return;
		const check = () => {
			const watched = this.watched.get(chatId);
			const signature = this.signature(chatId);
			if (watched === undefined || watched.signature === signature) return;
			watched.signature = signature;
			this.reloadChat(chatId);
		};
		this.store.subscribe(`dialog:${chatId}`, check);
		this.store.subscribe(`chat:${chatId}`, check);
		this.watched.set(chatId, { signature: this.signature(chatId) });
	}

	private reloadChat(chatId: number): void {
		for (const key of this.lists.keys()) {
			if (key.startsWith(`${chatId}:`)) void this.fetch(chatId, Number(key.split(":")[1]));
		}
	}

	/** Loads the first page again; a reload keeps the shown list until the new one arrives. */
	private async fetch(chatId: number, topicId: number): Promise<void> {
		const key = listKey(chatId, topicId);
		let entry = this.lists.get(key);
		if (entry === undefined) {
			entry = { state: LOADING, generation: 0, loadingMore: false };
			this.lists.set(key, entry);
		}
		const generation = ++entry.generation;
		entry.loadingMore = false;
		try {
			const page = await this.source.pinnedMessages(chatId, { topicId, limit: PAGE });
			if (generation !== entry.generation) return;
			this.set(chatId, topicId, entry, { status: "ready", messages: page.messages, count: page.count, hasMore: page.hasMore });
		} catch (err) {
			if (generation !== entry.generation) return;
			this.store.reportError(err, `pinned messages ${chatId}`);
			// A list already shown stays; a first load falls back to the dialog's newest pin.
			if (entry.state.status !== "ready") this.set(chatId, topicId, entry, { ...LOADING, status: "error" });
		}
	}

	private set(chatId: number, topicId: number, entry: Entry, state: PinnedState): void {
		entry.state = state;
		const set = this.listeners.get(listKey(chatId, topicId));
		if (set === undefined) return;
		for (const listener of [...set]) listener();
	}
}

/** One list cache per store (per signed-in client); created with the first pinned bar. */
const bySession = new WeakMap<ChatStore, PinnedLists>();

export function pinnedLists(store: ChatStore): PinnedLists {
	let lists = bySession.get(store);
	if (lists === undefined) {
		lists = new PinnedLists(store);
		bySession.set(store, lists);
	}
	return lists;
}

/** Pinned messages of a chat or topic, newest first; undefined while not asked for (`enabled` false). */
export function usePinned(chatId: number, topicId: number, enabled: boolean): PinnedState | undefined {
	const { store } = useServices();
	const lists = pinnedLists(store);
	const subscribe = useCallback((listener: () => void) => lists.subscribe(chatId, topicId, listener), [lists, chatId, topicId]);
	const state = useSyncExternalStore(subscribe, () => (enabled ? lists.state(chatId, topicId) : undefined));
	useEffect(() => {
		if (enabled) lists.load(chatId, topicId);
	}, [lists, chatId, topicId, enabled]);
	return state;
}
