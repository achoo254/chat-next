// Production client: the core runs in this tab's worker (@app/platform-web)
// and talks to the realtime gateway at same-origin /ws. Loaded lazily with
// the messaging chunk, so the R0 shell never downloads the worker.
import { realtimeUrlFor } from "@app/core";
import { createWebChat } from "@app/platform-web";
import ChatWorker from "@app/platform-web/worker?worker";
import type { MessagingClient, MessagingConnectorOptions } from "./connector.ts";
import { ServerBackend } from "./server-backend.ts";

const APP_VERSION = "web-r1";

export function connectWebChat(options: MessagingConnectorOptions): MessagingClient {
	const chat = createWebChat({
		createWorker: () => new ChatWorker(),
		realtimeUrl: realtimeUrlFor(window.location.origin),
		appVersion: APP_VERSION,
		onSessionEnded: options.onSessionEnded,
		onNotificationClick: options.onNotificationClick,
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
