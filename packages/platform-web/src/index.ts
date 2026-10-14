// Main-thread API of the web platform. The worker entry is the package's
// "./worker" export (sqlite-worker.ts).
export {
	createWebChat,
	goToSignIn,
	openExternal,
	requestNotificationPermission,
	submitSignOut,
	type TabRole,
	type WebChat,
	type WebChatOptions,
	type WorkerLike,
} from "./client.ts";
export type { RemoteCore, WorkerConfig } from "./protocol.ts";
