// Service worker of the production web app: built to /sw.js by
// vite-service-worker.ts, registered by register-service-worker.ts. The
// behaviour lives in app-shell-worker.ts (app shell cache) and
// push-handlers.ts (Web Push); this entry hands them the real worker scope
// and the build compiled in.
import { startAppShellWorker, type AppShellBuild, type ServiceWorkerScopeLike } from "./app-shell-worker.ts";
import { startPushHandlers, type PushScopeLike } from "./push-handlers.ts";

/** The build's version, files and entry, written in by vite-service-worker.ts. */
declare const __APP_SHELL__: AppShellBuild;
/** brand.config.json pushSenderName, written in by vite-service-worker.ts. */
declare const __PUSH_APP_NAME__: string;

startAppShellWorker(globalThis as unknown as ServiceWorkerScopeLike, __APP_SHELL__, {
	caches,
	fetch: (request) => fetch(request),
});

startPushHandlers(globalThis as unknown as PushScopeLike, {
	fetch: (input, init) => fetch(input, init),
	appName: __PUSH_APP_NAME__,
	fallbackBody: "Bạn có tin nhắn mới",
});
