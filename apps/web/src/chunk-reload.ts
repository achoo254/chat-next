// After a deploy, a tab still running the previous build may ask for one of
// its lazy chunks that the server no longer serves (nginx serves only the
// current release's /assets/). The import then fails, React unmounts the app
// and only the page splash ("Đang tải…") is left. When that happens the page
// reloads once, which loads the current build. A second failure within
// RELOAD_GUARD_MS does not reload again (the new build itself may be broken
// or the network down): the splash shows a message and a reload button.

/** A failure within this time of the last automatic reload shows the notice instead. */
export const RELOAD_GUARD_MS = 60_000;
const RELOAD_KEY = "chunk-reload-at";
// Set once this page decided to reload: the same failure then reaches React, Vite and the
// rejection handler in turn, and none of them should show the notice meanwhile.
let reloading = false;

// What browsers say when a dynamic import or its preloaded CSS cannot be loaded.
const CHUNK_ERRORS = [
	/Failed to fetch dynamically imported module/i, // Chrome, Edge
	/error loading dynamically imported module/i, // Firefox
	/Importing a module script failed/i, // Safari
	/Unable to preload CSS/i, // Vite's CSS preload
	/ChunkLoadError/i,
];

/** Whether `error` says a chunk of the app could not be loaded. */
export function isChunkLoadError(error: unknown): boolean {
	const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	return CHUNK_ERRORS.some((pattern) => pattern.test(text));
}

function lastReload(storage: Storage | undefined): number {
	try {
		return Number(storage?.getItem(RELOAD_KEY) ?? 0) || 0;
	} catch {
		return 0;
	}
}

/**
 * Reloads the page unless it already reloaded for this within RELOAD_GUARD_MS;
 * returns whether it reloads. Without session storage (blocked) it never reloads by itself.
 */
export function reloadForNewBuild(now = Date.now(), storage: Storage | undefined = globalThis.sessionStorage, reload = () => location.reload()): boolean {
	if (storage === undefined || now - lastReload(storage) < RELOAD_GUARD_MS) return false;
	try {
		storage.setItem(RELOAD_KEY, String(now));
	} catch {
		// Without a place to remember the reload, reloading could loop: the notice asks instead.
		return false;
	}
	reloading = true;
	reload();
	return true;
}

// The notice is written before React or the copy of the UI language may be
// available (the app just failed to load), so its few words live here.
const NOTICE: Record<string, { text: string; reload: string }> = {
	vi: { text: "Không tải được phần mới của ứng dụng.", reload: "Tải lại" },
	en: { text: "Couldn't load the new version of the app.", reload: "Reload" },
	zh: { text: "无法加载应用的新版本。", reload: "重新加载" },
};

/** Turns the page splash into a message with a reload button (the guard stopped an automatic reload). */
export function showReloadNotice(doc: Document = document): void {
	const splash = doc.getElementById("splash");
	if (splash === null) return;
	const lang = doc.documentElement.lang.slice(0, 2).toLowerCase();
	const words = NOTICE[lang] ?? NOTICE.vi;
	splash.hidden = false;
	splash.setAttribute("aria-busy", "false");
	splash.classList.add("reload-notice");
	const text = splash.querySelector(".brand-loader-text") ?? splash.appendChild(doc.createElement("p"));
	text.textContent = words?.text ?? "";
	if (splash.querySelector("button") !== null) return;
	const button = doc.createElement("button");
	button.type = "button";
	button.className = "btn";
	button.textContent = words?.reload ?? "";
	button.addEventListener("click", () => location.reload());
	splash.appendChild(button);
}

/** Handles a chunk failure that reached the top: reload once, else show the notice. Returns whether it was one. */
export function recoverFromChunkError(error: unknown): boolean {
	if (!isChunkLoadError(error)) return false;
	if (!reloading && !reloadForNewBuild()) showReloadNotice();
	return true;
}

/** Listens for failed dynamic imports that do not reach React (Vite's preload event, unhandled rejections). */
export function installChunkReload(): void {
	addEventListener("vite:preloadError", (event) => {
		recoverFromChunkError((event as Event & { payload?: unknown }).payload ?? new Error("Unable to preload CSS"));
	});
	addEventListener("unhandledrejection", (event) => {
		recoverFromChunkError(event.reason);
	});
}
