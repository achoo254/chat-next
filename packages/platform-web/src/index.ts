// Main-thread API of the web platform. The worker entry is the package's
// "./worker" export (sqlite-worker.ts).
export {
	createWebChat,
	goToSignIn,
	LAST_USER_KEY,
	openExternal,
	requestNotificationPermission,
	submitSignOut,
	type ShownNotification,
	type TabRole,
	type WebChat,
	type WebChatOptions,
	type WorkerLike,
} from "./client.ts";
export type { NativeConnection, RemoteCore, WorkerConfig } from "./protocol.ts";
