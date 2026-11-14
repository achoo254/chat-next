// The AI's CLI in the session's terminal can go on in another conversation
// (Claude: /clear for a new one, /resume to another). The machine marks that
// with a conversation break (a status item with no text under a reserved id,
// see isConversationBreak) and keeps everything before it; the session
// shows the conversation from its latest break on, and what came before only
// on request. Items belong to the side of the break they were written on (by
// seq, not by display order): a conversation the CLI went back to keeps its
// own older times but is written again after the break.
import { Role, type Item } from "@achoo254/chat-proto/remote/remote";
import { isConversationBreak } from "@achoo254/chat-remote-protocol";

export interface Conversations {
	/** Items of the earlier conversations, in display order; empty when there was no break. */
	readonly previous: readonly Item[];
	/** Items of the conversation the session is in now, in display order. */
	readonly current: readonly Item[];
	/** The latest break's id: changes when the CLI goes on in yet another conversation; "" when there was none. */
	readonly breakId: string;
}

/** Splits a thread's items (in display order) at its latest conversation break; the break items themselves are dropped. */
export function splitConversations(items: readonly Item[]): Conversations {
	let latest: Item | null = null;
	for (const item of items) {
		if (isConversationBreak(item) && (latest === null || item.seq > latest.seq)) latest = item;
	}
	if (latest === null) return { previous: [], current: items, breakId: "" };
	const from = latest.seq;
	const previous: Item[] = [];
	const current: Item[] = [];
	for (const item of items) {
		if (isConversationBreak(item)) continue;
		(item.seq > from ? current : previous).push(item);
	}
	return { previous, current, breakId: latest.id };
}

/** How many messages the items hold: what the user typed and what the AI answered (thinking, tools and notes not counted). */
export function messageCount(items: readonly Item[]): number {
	let n = 0;
	for (const item of items) {
		const b = item.body;
		if (b.case === "text" && (b.value.role === Role.USER || b.value.role === Role.ASSISTANT) && (b.value.text !== "" || b.value.attachments.length > 0)) n += 1;
	}
	return n;
}
