// Selecting several messages of the open chat (as Telegram's and Zalo's "Select"): the menu
// starts it with one message, a click adds or removes one (an album as a whole), Shift+click
// adds the run from the last one clicked, and the selection bar acts on them all through the
// same calls as one message's menu, so a chat synced with another app follows as it does for
// one message.
import type { StoredMessage } from "@achoo254/chat-core";
import type { WindowItem } from "../data/store.ts";
import type { MessageSelection, Ui } from "./ui-context.tsx";

/** At most this many messages are selected: what the server takes in one forward or delete. */
export const SELECTION_MAX = 100;

/** Every message of an album (sent as one, same author), else the message alone. */
export function albumSeqs(items: readonly WindowItem[], message: StoredMessage): number[] {
	if (message.groupedId === 0) return [message.seq];
	return items.flatMap((item) =>
		item.kind === "message" && !item.message.recalled && item.message.groupedId === message.groupedId && item.message.fromId === message.fromId
			? [item.message.seq]
			: [],
	);
}

/** Messages that can be selected, oldest first: sent ones, not system lines or messages still sending. */
function selectable(items: readonly WindowItem[]): StoredMessage[] {
	return items.flatMap((item) => (item.kind === "message" && item.message.action === null ? [item.message] : []));
}

function sorted(seqs: Iterable<number>): number[] {
	return [...new Set(seqs)].sort((a, b) => a - b);
}

/** Starts selecting with these messages (one message, or an album). */
export function startSelection(ui: Ui, chatId: number, seqs: readonly number[]): void {
	ui.selection.set({ chatId, seqs: sorted(seqs).slice(0, SELECTION_MAX), anchor: seqs[0] ?? 0 });
}

export interface Toggled {
	/** The new selection; null when the last message was taken out (selecting ends). */
	readonly selection: MessageSelection | null;
	/** Some messages were left out to stay within SELECTION_MAX. */
	readonly capped: boolean;
}

/**
 * Clicking `seqs` (one message, or an album) while selecting: out when it is selected, in
 * otherwise. `range` (Shift) adds every selectable message from the anchor to it.
 */
export function toggleSelection(current: MessageSelection, items: readonly WindowItem[], seqs: readonly number[], range: boolean): Toggled {
	const clicked = seqs[0] ?? 0;
	const has = new Set(current.seqs);
	let next: number[];
	if (range && current.anchor !== 0) {
		const low = Math.min(current.anchor, clicked);
		const high = Math.max(current.anchor, ...seqs);
		const run = selectable(items)
			.map((message) => message.seq)
			.filter((seq) => seq >= low && seq <= high);
		next = sorted([...current.seqs, ...run, ...seqs]);
	} else if (seqs.some((seq) => has.has(seq))) {
		next = current.seqs.filter((seq) => !seqs.includes(seq));
	} else {
		next = sorted([...current.seqs, ...seqs]);
	}
	const capped = next.length > SELECTION_MAX;
	if (capped) next = next.slice(0, SELECTION_MAX);
	if (next.length === 0) return { selection: null, capped: false };
	return { selection: { chatId: current.chatId, seqs: next, anchor: range ? current.anchor : clicked }, capped };
}

