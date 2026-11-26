// Startup half of chunk-reload.ts: listens for errors that reach the top and
// loads the handler only then, so the startup bundle stays within its budget.
// If the handler itself cannot be loaded (its chunk failed too), a failed
// chunk still reloads the page, at most once a minute (the same session key).

const CHUNK_ERROR = /dynamically imported module|module script failed|preload CSS|ChunkLoadError/i;

function reloadOnce(): void {
	try {
		const at = Number(sessionStorage.getItem("chunk-reload-at")) || 0;
		if (Date.now() - at < 60_000) return;
		sessionStorage.setItem("chunk-reload-at", String(Date.now()));
	} catch {
		return;
	}
	location.reload();
}

/** Hands `error` to chunk-reload.ts; `unmounted`: React removed the app (onUncaughtError). */
export function recoverAfterError(error: unknown, unmounted: boolean): void {
	import("./chunk-reload.ts").then(
		(handler) => handler.recoverFromError(error, unmounted),
		() => {
			if (CHUNK_ERROR.test(String(error))) reloadOnce();
		},
	);
}

/** Failed dynamic imports that do not reach React: Vite's preload event and unhandled rejections. */
export function installErrorRecovery(): void {
	addEventListener("vite:preloadError", (event) => recoverAfterError((event as Event & { payload?: unknown }).payload ?? "Unable to preload CSS", false));
	addEventListener("unhandledrejection", (event) => recoverAfterError(event.reason, false));
}
