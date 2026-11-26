// «Liên hệ» of AI Agent as data: the rows (each one-to-one chat and each
// group is a row of its own), what the machine says of each row's pushing
// (ChatInboxItem), and the requests a row's controls send.
import { ChatInboxItemState, type ChatInboxItem } from "@achoo254/chat-proto/remote/remote";
import type { DialogView } from "@achoo254/chat-core";

/** One chat of a row: where its messages come from. */
export interface ContactChat {
	readonly chatId: number;
	/** "telegram", "zalo"; "" for Chat itself. */
	readonly app: string;
	/** The name a turn and the session use for the chat. */
	readonly title: string;
	readonly hiddenFromAi: boolean;
}

export interface ContactRow {
	/** "c<chat id>". */
	readonly key: string;
	readonly name: string;
	readonly group: boolean;
	/** The chats the row's controls act on. */
	readonly chats: readonly ContactChat[];
}

/** The per-hour limits the row offers; the machine's default first. */
export const LIMITS = [20, 10, 40, 120] as const;
export const DEFAULT_LIMIT = 20;

/**
 * The rows of «Liên hệ» from the chat list (`order`, newest first, and its
 * views). The user's own saved chat, bots, channels and chats the user
 * left are not contacts.
 */
export function contactRows(order: readonly number[], viewOf: (chatId: number) => DialogView | undefined, selfId: number): ContactRow[] {
	const rows: ContactRow[] = [];
	const hidden = (chatId: number) => viewOf(chatId)?.dialog.hiddenFromAi === true;
	for (const chatId of order) {
		const view = viewOf(chatId);
		const chat = view?.chat ?? null;
		if (view === undefined || chat === null || chat.left) continue;
		if (chat.type === "group") {
			rows.push({ key: `c${chatId}`, name: chat.title, group: true, chats: [{ chatId, app: chat.externalApp ?? "", title: chat.title, hiddenFromAi: hidden(chatId) }] });
			continue;
		}
		const peer = view.peer;
		if (chat.type !== "private" || peer === null || peer.isBot || peer.id === selfId || chat.peerUserId === selfId) continue;
		rows.push({ key: `c${chatId}`, name: peer.name, group: false, chats: [{ chatId, app: chat.externalApp ?? "", title: peer.name, hiddenFromAi: hidden(chatId) }] });
	}
	return rows;
}

/** Folded for matching: lower case, no accents ("Đạt" finds "dat"). */
function fold(text: string): string {
	return text
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/đ/gi, "d")
		.toLowerCase();
}

export function matchRows(rows: readonly ContactRow[], query: string): ContactRow[] {
	const q = fold(query.trim());
	return q === "" ? [...rows] : rows.filter((row) => fold(row.name).includes(q));
}

/** The apps a row reaches, once each, in its chats' order. */
export function rowApps(row: ContactRow): string[] {
	return [...new Set(row.chats.map((c) => c.app))];
}

/** What the machine says of a row: its chats' items folded into one line. */
export type RowStatus =
	| { readonly kind: "off" }
	| { readonly kind: "paused" }
	| { readonly kind: "active"; readonly delivered: number }
	| { readonly kind: "hidden" }
	| { readonly kind: "limited"; readonly missed: number }
	| { readonly kind: "error" }
	| { readonly kind: "signedOut" };

/** The worse state first: what the user must act on shows over what goes well. */
const SEVERITY: Readonly<Record<number, number>> = {
	[ChatInboxItemState.SIGNED_OUT]: 5,
	[ChatInboxItemState.ERROR]: 4,
	[ChatInboxItemState.HIDDEN]: 3,
	[ChatInboxItemState.LIMITED]: 2,
	[ChatInboxItemState.ACTIVE]: 1,
};

export function rowItems(row: ContactRow, items: readonly ChatInboxItem[]): ChatInboxItem[] {
	const ids = new Set(row.chats.map((c) => BigInt(c.chatId)));
	return items.filter((item) => ids.has(item.chatId));
}

export function rowStatus(row: ContactRow, items: readonly ChatInboxItem[]): RowStatus {
	const mine = rowItems(row, items);
	if (mine.length === 0) return { kind: "off" };
	const on = mine.filter((item) => item.enabled);
	if (on.length === 0) return { kind: "paused" };
	const worst = on.reduce((a, b) => ((SEVERITY[b.state] ?? 0) > (SEVERITY[a.state] ?? 0) ? b : a));
	switch (worst.state) {
		case ChatInboxItemState.SIGNED_OUT:
			return { kind: "signedOut" };
		case ChatInboxItemState.ERROR:
			return { kind: "error" };
		case ChatInboxItemState.HIDDEN:
			return { kind: "hidden" };
		case ChatInboxItemState.LIMITED:
			return { kind: "limited", missed: on.reduce((n, item) => n + item.missed, 0) };
		default:
			return { kind: "active", delivered: on.reduce((n, item) => n + item.deliveredLastHour, 0) };
	}
}

/** Whether the row pushes (any of its chats on). */
export function rowEnabled(row: ContactRow, items: readonly ChatInboxItem[]): boolean {
	return rowItems(row, items).some((item) => item.enabled);
}

/** The row's limit as the machine keeps it (its first chat's), else the default. */
export function rowLimit(row: ContactRow, items: readonly ChatInboxItem[]): number {
	return rowItems(row, items)[0]?.perHourLimit || DEFAULT_LIMIT;
}

/** The ChatInboxSet requests turning a row on or off, or changing its limit: one per chat of the row. */
export function inboxSets(row: ContactRow, enabled: boolean, perHourLimit: number): { chatId: bigint; title: string; app: string; enabled: boolean; perHourLimit: number }[] {
	return row.chats.map((c) => ({ chatId: BigInt(c.chatId), title: c.title, app: c.app, enabled, perHourLimit }));
}
