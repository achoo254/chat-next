// Production client: the core runs in this tab's worker (@achoo254/chat-platform-web)
// and talks to the realtime gateway at same-origin /ws (the native app: the
// server's /ws, with its bearer token). Loaded lazily with the messaging
// chunk, so the R0 shell never downloads the worker.
import { createWebChat, type WebChatOptions } from "@achoo254/chat-platform-web";
import ChatWorker from "@achoo254/chat-platform-web/worker?worker";
import type { MessagingClient, MessagingConnectorOptions } from "./connector.ts";
import { ServerBackend } from "./server-backend.ts";
import { serverOrigin } from "../../server-origin.ts";

const APP_VERSION = "web-r1";

/** What the native app adds: its server connection, sign-out ending and foreground source. */
export type NativeChatOptions = Pick<WebChatOptions, "native" | "leave" | "onForegroundChange" | "appVersion">;

export function connectWebChat(options: MessagingConnectorOptions, native?: NativeChatOptions): MessagingClient {
	const chat = createWebChat({
		createWorker: () => new ChatWorker(),
		apiOrigin: serverOrigin(),
		appVersion: APP_VERSION,
		...native,
		onSessionEnded: options.onSessionEnded,
		onNotificationClick: options.onNotificationClick,
		filterNotification: options.filterNotification,
		onError: options.onError,
	});
	return {
		source: chat,
		createBackend: (remote, source) => new ServerBackend(remote, source),
		coldSnapshot: () => chat.coldSnapshot(),
		saveSnapshot: () => chat.saveSnapshot(),
		signOutAndLeave: () => chat.signOutAndLeave(),
		dispose: () => chat.dispose(),
	};
}
