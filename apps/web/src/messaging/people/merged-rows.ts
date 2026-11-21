// What a person's merged timeline draws, decided apart from React: the rows
// (an album's consecutive messages of one chat read as one row, as in a
// chat's own list), where the unread divider sits and where a quoted message
// is. Pure, so each rule has a unit test.
import type { StoredMessage } from "@achoo254/chat-core";
import type { MergedItem } from "./merged-order.ts";

export interface MergedGroup {
	/** Key of the row: the first message's key. */
	readonly key: string;
	/** The row's message that carries the bubble: an album's captioned message (else its first). */
	readonly item: MergedItem;
	/** Every message of an album, oldest first; empty for a single message or a send on its way. */
	readonly album: readonly MergedItem[];
}

/** What groups a message into an album: its chat, sender and grouped id; "" for none. */
function albumOf(item: MergedItem): string {
	if (item.kind !== "message") return "";
	const message = item.message;
	if (message.groupedId === 0 || message.recalled || message.action !== null) return "";
	return `${item.chatId}:${message.fromId}:${message.groupedId}`;
}

/** The rows of the timeline: an album's consecutive messages in one row, every other item in its own. */
export function groupMerged(items: readonly MergedItem[]): MergedGroup[] {
	const groups: { members: MergedItem[]; album: string }[] = [];
	for (const item of items) {
		const album = albumOf(item);
		const last = groups[groups.length - 1];
		if (album !== "" && last !== undefined && last.album === album) last.members.push(item);
		else groups.push({ members: [item], album });
	}
	return groups.map(({ members }) => {
		const first = members[0];
		if (first === undefined) throw new Error("empty group");
		if (members.length === 1) return { key: first.key, item: first, album: [] };
		const caption = members.find((member) => member.kind === "message" && member.message.text !== "") ?? first;
		return { key: first.key, item: caption, album: members };
	});
}

/** The messages of an album row in order (only confirmed messages: a send on its way is never in an album here). */
export function albumMessages(group: MergedGroup): StoredMessage[] {
	return group.album.flatMap((member) => (member.kind === "message" ? [member.message] : []));
}

/** Per chat, the first unread seq when the screen opened (0 or missing: none). */
export type UnreadFrom = ReadonlyMap<number, number>;

/**
 * The row the unread divider sits above: the oldest incoming message that was
 * unread when the screen opened, in any of the chats. Once the reader has
 * answered below it (a message of theirs, sent or pending) it has done its
 * job: "" then, and when there is none.
 */
export function unreadDividerKey(groups: readonly MergedGroup[], unreadFrom: UnreadFrom, selfId: number): string {
	let found = "";
	for (const group of groups) {
		const item = group.item;
		if (found === "") {
			const from = unreadFrom.get(item.chatId) ?? 0;
			if (item.kind === "message" && from !== 0 && item.message.seq >= from && item.message.fromId !== selfId && item.message.action === null) {
				found = group.key;
			}
		} else if (item.kind === "pending" || (item.kind === "message" && item.message.fromId === selfId)) {
			return "";
		}
	}
	return found;
}

/** The row holding message `seq` of `chatId`, or null when it is not on the timeline (older than what is loaded). */
export function rowOfMessage(groups: readonly MergedGroup[], chatId: number, seq: number): string | null {
	for (const group of groups) {
		const members = group.album.length > 0 ? group.album : [group.item];
		if (members.some((member) => member.chatId === chatId && member.kind === "message" && member.message.seq === seq)) return group.key;
	}
	return null;
}
