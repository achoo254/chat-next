// "Last screen" snapshot for cold start: the top of the dialog list and the
// open chat's newest messages, small enough to read synchronously before the
// database and the network are up. The platform stores it (web: storage of
// the main thread) and must drop it on sign-out like the database.
import type { Chat, Dialog, Message, User } from "../model/types.ts";
import type { Repository } from "../repo/repository.ts";

export const SNAPSHOT_VERSION = 1;

export interface SnapshotDialog {
	readonly dialog: Dialog;
	readonly chat: Chat | null;
	readonly topMessage: Message | null;
	readonly peer: User | null;
}

export interface ScreenSnapshot {
	readonly version: typeof SNAPSHOT_VERSION;
	readonly userId: number;
	/** Unix milliseconds. */
	readonly savedAt: number;
	readonly dialogs: readonly SnapshotDialog[];
	readonly openChat: { readonly chatId: number; readonly messages: readonly Message[] } | null;
	/** Authors of the open chat's messages. */
	readonly users: readonly User[];
}

export interface SnapshotLimits {
	readonly dialogs: number;
	readonly messages: number;
}

const DEFAULT_LIMITS: SnapshotLimits = { dialogs: 30, messages: 30 };

function strip<T extends { readonly stale: boolean }>(value: T): Omit<T, "stale"> {
	const { stale: _stale, ...rest } = value;
	return rest;
}

export async function buildSnapshot(
	repo: Repository,
	userId: number,
	openChatId: number,
	now: number,
	limits: SnapshotLimits = DEFAULT_LIMITS,
): Promise<ScreenSnapshot> {
	const views = await repo.dialogViews(limits.dialogs);
	const dialogs = views.map((view) => ({
		dialog: view.dialog,
		chat: view.chat,
		topMessage: view.topMessage === null ? null : strip(view.topMessage),
		peer: view.peer,
	}));
	let openChat: ScreenSnapshot["openChat"] = null;
	let users: User[] = [];
	if (openChatId !== 0) {
		const messages = (await repo.messagesBefore(openChatId, 0, limits.messages)).map(strip);
		openChat = { chatId: openChatId, messages };
		users = await repo.users([...new Set(messages.map((m) => m.fromId))]);
	}
	return { version: SNAPSHOT_VERSION, userId, savedAt: now, dialogs, openChat, users };
}

// Validation: the snapshot comes back from platform storage, which other
// code on the same origin can write, so its shape is checked before use.

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasNumbers(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return keys.every((key) => typeof value[key] === "number");
}

function isMessage(value: unknown): value is Message {
	return (
		isRecord(value) &&
		hasNumbers(value, ["chatId", "seq", "fromId", "date", "replyToSeq", "editVersion", "randomId"]) &&
		typeof value.text === "string" &&
		Array.isArray(value.entities) &&
		Array.isArray(value.reactions)
	);
}

function isUser(value: unknown): value is User {
	return isRecord(value) && typeof value.id === "number" && typeof value.name === "string";
}

function isChat(value: unknown): value is Chat {
	return isRecord(value) && typeof value.id === "number" && typeof value.type === "string";
}

function isDialog(value: unknown): value is Dialog {
	return isRecord(value) && hasNumbers(value, ["chatId", "topSeq", "readInboxMaxSeq", "unreadCount"]);
}

function isSnapshotDialog(value: unknown): value is SnapshotDialog {
	return (
		isRecord(value) &&
		isDialog(value.dialog) &&
		(value.chat === null || isChat(value.chat)) &&
		(value.topMessage === null || isMessage(value.topMessage)) &&
		(value.peer === null || isUser(value.peer))
	);
}

/** Returns the snapshot when it is well formed and belongs to `userId`, else null. */
export function parseSnapshot(value: unknown, userId: number): ScreenSnapshot | null {
	if (!isRecord(value) || value.version !== SNAPSHOT_VERSION || value.userId !== userId) return null;
	if (typeof value.savedAt !== "number") return null;
	if (!Array.isArray(value.dialogs) || !value.dialogs.every(isSnapshotDialog)) return null;
	if (!Array.isArray(value.users) || !value.users.every(isUser)) return null;
	const open = value.openChat;
	if (open !== null) {
		if (!isRecord(open) || typeof open.chatId !== "number") return null;
		if (!Array.isArray(open.messages) || !open.messages.every(isMessage)) return null;
	}
	return value as unknown as ScreenSnapshot; // every field checked above
}
