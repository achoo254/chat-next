// An error that unmounts the app leaves only the page splash ("Đang tải…").
// After a deploy, a tab of the previous build may ask for a lazy chunk the
// server no longer serves: such a failure reloads the page once to load the
// current build; another within RELOAD_GUARD_MS (or no session storage to
// remember the reload) does not loop but shows a notice with a reload button.
// Any other error that unmounted the app shows the notice, without a reload.
// Only this small part is in the startup bundle; the notice is a lazy chunk.

/** A failed chunk within this time of the last automatic reload shows the notice instead. */
export const RELOAD_GUARD_MS = 60_000;
const RELOAD_KEY = "chunk-reload-at";
// The same failure reaches the rejection handler and React in turn: once reloading, nothing else shows.
let reloading = false;

/** What browsers (and Vite's CSS preload) say when a dynamic import cannot be loaded. */
export function isChunkLoadError(error: unknown): boolean {
	return /dynamically imported module|module script failed|preload CSS/i.test(String(error));
}

/** Reloads unless it already did within RELOAD_GUARD_MS or cannot remember it; returns whether it reloads. */
export function reloadForNewBuild(now = Date.now(), storage: Storage | undefined = globalThis.sessionStorage, reload = () => location.reload()): boolean {
	try {
		if (storage === undefined || now - (Number(storage.getItem(RELOAD_KEY)) || 0) < RELOAD_GUARD_MS) return false;
		storage.setItem(RELOAD_KEY, String(now));
	} catch {
		return false;
	}
	reloading = true;
	reload();
	return true;
}

/** `unmounted`: React removed the app (onUncaughtError); events that did not unmount it only reload. */
export function recoverAfterError(error: unknown, unmounted: boolean): void {
	const chunk = isChunkLoadError(error);
	if (reloading || (chunk && reloadForNewBuild()) || (!chunk && !unmounted)) return;
	void import("./reload-notice.ts").then((notice) => notice.showReloadNotice(chunk ? "chunk" : "crash"));
}

/** A failed dynamic import outside React (Vite rethrows its preload errors to the importer). */
export function installErrorRecovery(): void {
	addEventListener("unhandledrejection", (event) => recoverAfterError(event.reason, false));
}
