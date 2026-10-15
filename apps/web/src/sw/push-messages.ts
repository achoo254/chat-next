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
