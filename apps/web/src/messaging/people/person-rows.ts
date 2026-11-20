// Person rows of the "Tất cả" folder (ADR 0025): the private chats of one
// linked person collapse into one row, put where the first of them would be
// in list order (pinned chats first, then the newest), so the row is pinned
// when one of its chats is and otherwise sorts by its newest chat. Other
// folders list every chat on its own. The "Tất cả" badge counts such a
// person once. Pure: the list loads it with the people, after the first screen.
import type { ListEntry } from "../data/store.ts";
import type { LinkedPerson } from "./people-api.ts";

export interface PersonRowItem {
	readonly person: LinkedPerson;
	/** The person's chats in the list, in list order. */
	readonly chatIds: readonly number[];
	/** The apps of those chats, each once, in the person's member order ("" for Chat). */
	readonly apps: readonly string[];
	/** One of the chats is pinned. */
	readonly pinned: boolean;
}

/** One row of the list: a chat id, or a person standing for several chats. */
export type ListItem = number | PersonRowItem;

/** The person each private chat of a linked person belongs to. */
function personByChat(people: readonly LinkedPerson[]): Map<number, LinkedPerson> {
	const byChat = new Map<number, LinkedPerson>();
	for (const person of people) {
		for (const member of person.members) if (member.chatId !== 0) byChat.set(member.chatId, person);
	}
	return byChat;
}

/** `entries` (in list order) with each linked person's private chats folded into one row. */
export function withPersonRows(entries: readonly ListEntry[], people: readonly LinkedPerson[]): ListItem[] {
	const byChat = personByChat(people);
	const chatsOf = new Map<number, ListEntry[]>();
	for (const entry of entries) {
		const person = entry.kind === "private" ? byChat.get(entry.chatId) : undefined;
		if (person !== undefined) chatsOf.set(person.id, [...(chatsOf.get(person.id) ?? []), entry]);
	}
	const items: ListItem[] = [];
	for (const entry of entries) {
		const person = entry.kind === "private" ? byChat.get(entry.chatId) : undefined;
		const chats = person === undefined ? undefined : chatsOf.get(person.id);
		if (person === undefined || chats === undefined) {
			items.push(entry.chatId);
			continue;
		}
		// The person's row goes where its first chat is; its other chats add nothing.
		if (chats[0] !== entry) continue;
		const inList = new Set(chats.map((chat) => chat.chatId));
		const apps = person.members.filter((member) => inList.has(member.chatId)).map((member) => member.app);
		items.push({ person, chatIds: [...inList], apps: [...new Set(apps)], pinned: chats.some((chat) => chat.pinned) });
	}
	return items;
}

/**
 * How many chats the "Tất cả" badge counted more than once: for each person,
 * its chats counted there (unread, and not muted unless muted chats count)
 * minus one.
 */
export function personBadgeExtra(entries: readonly ListEntry[], people: readonly LinkedPerson[], badgeMuted: boolean): number {
	const byChat = personByChat(people);
	const counted = new Map<number, number>();
	for (const entry of entries) {
		const person = entry.kind === "private" ? byChat.get(entry.chatId) : undefined;
		if (person === undefined || !entry.unread || (entry.muted && !badgeMuted)) continue;
		counted.set(person.id, (counted.get(person.id) ?? 0) + 1);
	}
	let extra = 0;
	for (const count of counted.values()) extra += count - 1;
	return extra;
}
