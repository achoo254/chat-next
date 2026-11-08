// One thread's journal as this device holds it (ADR 0013): items merged by id
// keeping the highest revision, and the cursor to resume from. Every change
// takes a new seq on the machine, so a resumed or reset thread only carries
// the latest revision of each item; display order is therefore the item's
// creation time (`at`, kept across revisions), ties broken by the seq it was
// first seen with. Immutable: each change returns a new journal for React.
import type { Item } from "@achoo254/chat-proto/remote/remote";

export interface Cursor {
	readonly epoch: bigint;
	readonly seq: bigint;
}

export interface Journal {
	readonly items: ReadonlyMap<string, Item>;
	/** Item ids in display order. */
	readonly order: readonly string[];
	/** Where to resume from; null before the first items arrived. */
	readonly cursor: Cursor | null;
	/** The seq each id had when this device first saw it (order tie-break). */
	readonly firstSeen: ReadonlyMap<string, bigint>;
}

export const EMPTY_JOURNAL: Journal = { items: new Map(), order: [], cursor: null, firstSeen: new Map() };

function before(a: Item, b: Item, firstSeen: ReadonlyMap<string, bigint>): number {
	if (a.at !== b.at) return a.at < b.at ? -1 : 1;
	const sa = firstSeen.get(a.id) ?? a.seq;
	const sb = firstSeen.get(b.id) ?? b.seq;
	return sa === sb ? 0 : sa < sb ? -1 : 1;
}

/** Applies a batch of items (ThreadItems) and moves the cursor. */
export function applyItems(journal: Journal, incoming: readonly Item[], cursor: Cursor | undefined): Journal {
	let items: Map<string, Item> | null = null;
	let firstSeen: Map<string, bigint> | null = null;
	let added = false;
	for (const item of incoming) {
		const current = (items ?? journal.items).get(item.id);
		// A repeat or an older revision changes nothing.
		if (current !== undefined && item.revision <= current.revision) continue;
		items ??= new Map(journal.items);
		items.set(item.id, item);
		if (current === undefined) {
			firstSeen ??= new Map(journal.firstSeen);
			firstSeen.set(item.id, item.seq);
			added = true;
		}
	}
	const nextCursor = cursor === undefined ? journal.cursor : laterCursor(journal.cursor, cursor);
	if (items === null) return nextCursor === journal.cursor ? journal : { ...journal, cursor: nextCursor };
	const seen = firstSeen ?? journal.firstSeen;
	const order = added ? [...items.values()].sort((a, b) => before(a, b, seen)).map((item) => item.id) : journal.order;
	return { items, order, cursor: nextCursor, firstSeen: seen };
}

/** A cursor from another epoch replaces ours; within one epoch it only moves forward. */
function laterCursor(current: Cursor | null, next: Cursor): Cursor {
	if (current === null || current.epoch !== next.epoch || next.seq > current.seq) return next;
	return current;
}

/** ThreadReset: forget everything; the snapshot that follows fills the journal again. */
export function resetJournal(): Journal {
	return EMPTY_JOURNAL;
}

/** Items in display order. */
export function orderedItems(journal: Journal): Item[] {
	const out: Item[] = [];
	for (const id of journal.order) {
		const item = journal.items.get(id);
		if (item !== undefined) out.push(item);
	}
	return out;
}
