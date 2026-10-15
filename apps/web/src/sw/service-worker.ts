// Service worker of the production web app: built to /sw.js by
// vite-service-worker.ts, registered by register-service-worker.ts. The
// behaviour lives in app-shell-worker.ts; this entry hands it the real
// worker scope and the build compiled in.
import { startAppShellWorker, type AppShellBuild, type ServiceWorkerScopeLike } from "./app-shell-worker.ts";

/** The build's version, files and entry, written in by vite-service-worker.ts. */
declare const __APP_SHELL__: AppShellBuild;

startAppShellWorker(globalThis as unknown as ServiceWorkerScopeLike, __APP_SHELL__, {
	caches,
	fetch: (request) => fetch(request),
});
