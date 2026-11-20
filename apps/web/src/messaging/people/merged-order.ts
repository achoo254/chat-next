// Pure parts of the merged timeline of a person: the per-chat buffers, the
// old bound that keeps not-yet-loaded history from being mis-inserted, and
// the chronological merge. No I/O here; MergedTimeline drives the loads.
import type { FailureKind, PendingMessage, StoredMessage } from "@achoo254/chat-core";
import { messageKey, pendingKey, type WindowItem } from "../data/store.ts";

/** One private chat of the person, buffered outside the store's windows (never trimmed). */
export interface ChatBuffer {
	readonly chatId: number;
	/** The member's app ("telegram", …; "" for Chat). */
	readonly app: string;
	/** Ascending by seq. */
	messages: readonly StoredMessage[];
	/** Unconfirmed sends; only the newest page carries them. */
	pending: readonly PendingMessage[];
	hasOlder: boolean;
	/** The newest page arrived at least once. */
	loaded: boolean;
	failure: FailureKind | null;
}

/** A row of the merged list: a store window item plus where it comes from. */
export type MergedItem = WindowItem & {
	/** Unique across the person's chats; survives pending → confirmed. */
	readonly key: string;
	readonly chatId: number;
	readonly app: string;
};

/** Position in the merged order: date, then chat, then seq, so equal dates stay stable. */
interface OrderKey {
	readonly date: number;
	readonly chatId: number;
	readonly seq: number;
}

const ABOVE_EVERYTHING: OrderKey = { date: Infinity, chatId: Infinity, seq: Infinity };

function compareKeys(a: OrderKey, b: OrderKey): number {
	return a.date - b.date || a.chatId - b.chatId || a.seq - b.seq;
}

function keyOf(message: StoredMessage): OrderKey {
	return { date: message.date, chatId: message.chatId, seq: message.seq };
}

export function newBuffer(chatId: number, app: string): ChatBuffer {
	return { chatId, app, messages: [], pending: [], hasOlder: true, loaded: false, failure: null };
}

/**
 * The chat may still have history older than what is buffered, so it limits
 * what can be shown. A chat whose first load failed with nothing cached does
 * not: it would otherwise hide every other chat.
 */
function holdsBound(buffer: ChatBuffer): boolean {
	if (buffer.failure !== null && buffer.messages.length === 0) return false;
	return !buffer.loaded || buffer.hasOlder;
}

/**
 * The oldest position every chat with more history has loaded back to (null:
 * no chat holds it, everything is shown). Unloaded history of a holding chat
 * sorts below its oldest buffered message, so below the bound: showing only
 * what is at or above it never places a later-loaded message between rows.
 */
export function oldBound(buffers: readonly ChatBuffer[]): OrderKey | null {
	let bound: OrderKey | null = null;
	for (const buffer of buffers) {
		if (!holdsBound(buffer)) continue;
		const oldest = buffer.messages[0];
		const key = oldest === undefined ? ABOVE_EVERYTHING : keyOf(oldest);
		if (bound === null || compareKeys(key, bound) > 0) bound = key;
	}
	return bound;
}

/** The chats to load further back: those holding the bound at its date (all of them on a tie). */
export function boundHolders(buffers: readonly ChatBuffer[]): ChatBuffer[] {
	const bound = oldBound(buffers);
	if (bound === null) return [];
	return buffers.filter((buffer) => holdsBound(buffer) && (buffer.messages[0]?.date ?? Infinity) === bound.date);
}

export function anyHoldsBound(buffers: readonly ChatBuffer[]): boolean {
	return buffers.some(holdsBound);
}

/**
 * The visible rows: messages at or above the old bound in merged order, then
 * every chat's pending sends (they follow the newest message by definition).
 * Rows equal to one in `previous` keep its identity so unchanged rows do not
 * re-render.
 */
export function mergeItems(buffers: readonly ChatBuffer[], previous: ReadonlyMap<string, MergedItem>): MergedItem[] {
	const bound = oldBound(buffers);
	const shown: { message: StoredMessage; app: string }[] = [];
	for (const buffer of buffers) {
		for (const message of buffer.messages) {
			if (bound === null || compareKeys(keyOf(message), bound) >= 0) shown.push({ message, app: buffer.app });
		}
	}
	shown.sort((a, b) => compareKeys(keyOf(a.message), keyOf(b.message)));
	const pending = buffers
		.flatMap((buffer) => buffer.pending.map((item) => ({ pending: item, app: buffer.app })))
		.sort((a, b) => a.pending.date - b.pending.date || a.pending.chatId - b.pending.chatId || a.pending.localSeq - b.pending.localSeq);

	const items: MergedItem[] = [];
	for (const { message, app } of shown) {
		const key = `${message.chatId}:${messageKey(message)}`;
		const old = previous.get(key);
		items.push(old?.kind === "message" && old.message === message ? old : { kind: "message", message, key, chatId: message.chatId, app });
	}
	const confirmed = new Set(items.map((item) => item.key));
	for (const { pending: item, app } of pending) {
		const key = `${item.chatId}:${pendingKey(item)}`;
		// A send confirmed between two reads shows once, as the message.
		if (confirmed.has(key)) continue;
		const old = previous.get(key);
		items.push(old?.kind === "pending" && old.pending === item ? old : { kind: "pending", pending: item, key, chatId: item.chatId, app });
	}
	return items;
}

/** Plain data read from the source: equal serialisations mean equal content. */
function sameContent<T>(a: T, b: T): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** Keeps the old object of each entry that did not change, so identity tracks content. */
function keepUnchanged<T>(fresh: readonly T[], old: readonly T[], idOf: (item: T) => number): T[] {
	if (old.length === 0) return [...fresh];
	const byId = new Map(old.map((item) => [idOf(item), item]));
	return fresh.map((item) => {
		const kept = byId.get(idOf(item));
		return kept !== undefined && sameContent(kept, item) ? kept : item;
	});
}

/**
 * Applies the newest messages of a chat (ascending by seq, possibly several
 * pages joined to reach the buffer after missed updates): they replace the
 * buffer from their oldest seq up, and the older buffered messages stay.
 */
export function applyNewest(buffer: ChatBuffer, fetched: readonly StoredMessage[], fetchedHasOlder: boolean, pending: readonly PendingMessage[]): void {
	const lowest = fetched[0]?.seq;
	if (lowest === undefined) {
		// An empty newest page: the chat has no messages left at all.
		buffer.messages = [];
		buffer.hasOlder = fetchedHasOlder;
	} else {
		const kept = buffer.messages.filter((message) => message.seq < lowest);
		buffer.messages = [...kept, ...keepUnchanged(fetched, buffer.messages, (message) => message.seq)];
		if (kept.length === 0) buffer.hasOlder = fetchedHasOlder;
	}
	buffer.pending = keepUnchanged(pending, buffer.pending, (item) => item.outboxId);
	buffer.loaded = true;
}

/** Adds an older page below the buffer. */
export function applyOlder(buffer: ChatBuffer, page: readonly StoredMessage[], hasOlder: boolean): void {
	const oldest = buffer.messages[0]?.seq ?? Infinity;
	buffer.messages = [...page.filter((message) => message.seq < oldest), ...buffer.messages];
	buffer.hasOlder = hasOlder;
}

/** Replaces one buffered message after an edit or reaction, or removes it (null: deleted). */
export function applyOne(buffer: ChatBuffer, seq: number, message: StoredMessage | null): void {
	const index = buffer.messages.findIndex((item) => item.seq === seq);
	if (index < 0) return;
	const old = buffer.messages[index];
	if (message !== null && old !== undefined && sameContent(old, message)) return;
	const next = [...buffer.messages];
	if (message === null) next.splice(index, 1);
	else next[index] = message;
	buffer.messages = next;
}
