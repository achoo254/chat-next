// The one message from the service worker to an open tab about pushes: a
// click on a push notification focused this tab, open the chat. The tab
// navigates itself (client-side), keeping its state, instead of the worker
// reloading it with WindowClient.navigate.

export const OPEN_CHAT = "app-push:open-chat";

export interface OpenChatMessage {
	readonly type: typeof OPEN_CHAT;
	readonly chatId: number;
}

/** The chat id of an open-chat message, or null for anything else. */
export function openChatId(data: unknown): number | null {
	if (typeof data !== "object" || data === null) return null;
	const { type, chatId } = data as { type?: unknown; chatId?: unknown };
	return type === OPEN_CHAT && typeof chatId === "number" && Number.isSafeInteger(chatId) && chatId > 0 ? chatId : null;
}

/** A click on a machine's push ("needs you", ADR 0013): open that machine, its waiting thread or its usage. */
export const OPEN_PATH = "app-push:open-path";

export interface OpenPathMessage {
	readonly type: typeof OPEN_PATH;
	readonly path: string;
}

/**
 * The only paths a push may open: a machine, one of its threads or its usage
 * (under /ai, or /machines from an older worker), or the machines settings
 * with the account's devices.
 */
const MACHINE_PATH = /^\/(?:ai|machines)\/[1-9][0-9]{0,15}(?:\/usage|\/s\/[A-Za-z0-9_-]{1,64})?$|^\/ai\/machines$/;

export function isMachinePath(path: string): boolean {
	return MACHINE_PATH.test(path);
}

/** The path of an open-path message, or null for anything else. */
export function openPath(data: unknown): string | null {
	if (typeof data !== "object" || data === null) return null;
	const { type, path } = data as { type?: unknown; path?: unknown };
	return type === OPEN_PATH && typeof path === "string" && isMachinePath(path) ? path : null;
}
