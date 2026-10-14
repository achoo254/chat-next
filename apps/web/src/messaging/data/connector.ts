// How the messaging UI gets its client. Production uses the worker-backed
// web client (web-client.ts); tests and the visual harness pass their own
// connector built on the core's in-memory test server.
import type { SessionEndReason } from "@app/core";
import type { NotificationDecision, NotificationInput } from "./notification-filter.ts";
import type { PendingBackend } from "./pending-backend.ts";
import type { Remote } from "./remote.ts";
import type { ChatSource, WebExtras } from "./source.ts";

export interface MessagingConnectorOptions {
	readonly onSessionEnded: (reason: SessionEndReason) => void;
	readonly onNotificationClick: (chatId: number) => void;
	readonly onError: (context: string, message: string) => void;
	/** Applies the user's notification settings and mutes; null shows nothing. */
	readonly filterNotification: (request: NotificationInput) => NotificationDecision | null;
}

export interface MessagingClient extends WebExtras {
	readonly source: ChatSource;
	/** The server features that vary by release, built on the app's Remote. */
	createBackend(remote: Remote, source: ChatSource): PendingBackend;
}

export type MessagingConnector = (options: MessagingConnectorOptions) => MessagingClient | Promise<MessagingClient>;

/** The production connector, loaded on first use. */
export const webConnector: MessagingConnector = async (options) => {
	const { connectWebChat } = await import("./web-client.ts");
	return connectWebChat(options);
};
