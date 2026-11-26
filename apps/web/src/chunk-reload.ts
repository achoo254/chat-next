// After a deploy, a tab still running the previous build may ask for one of
// its lazy chunks that the server no longer serves (nginx serves only the
// current release's /assets/). The import then fails, React unmounts the app
// and only the page splash ("Đang tải…") is left. When that happens the page
// reloads once, which loads the current build. This module is loaded only
// when an error reaches the top (error-recovery.ts keeps startup small). A second failure within
// RELOAD_GUARD_MS does not reload again (the new build itself may be broken
// or the network down): the splash shows a message and a reload button.
// Any other error that unmounts the app shows the same notice, without an
// automatic reload (the app never reloads by itself for anything else).

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

// The notice is written after React has unmounted the app, when the copy of
// the UI language may not be loaded, so its few words live here.
// chunk: a lazy part of the app could not be loaded twice in a row; crash: any
// other error that reached the top and unmounted the app.
export type NoticeKind = "chunk" | "crash";
const NOTICE: Record<string, { chunk: string; crash: string; reload: string }> = {
	vi: { chunk: "Không tải được phần mới của ứng dụng.", crash: "Ứng dụng gặp lỗi và đã dừng.", reload: "Tải lại" },
	en: { chunk: "Couldn't load the new version of the app.", crash: "Something went wrong and the app stopped.", reload: "Reload" },
	zh: { chunk: "无法加载应用的新版本。", crash: "应用出错，已停止运行。", reload: "重新加载" },
};

/** Turns the page splash, which shows again once the app is unmounted, into a message with a reload button. */
export function showReloadNotice(kind: NoticeKind = "chunk", doc: Document = document): void {
	const splash = doc.getElementById("splash");
	if (splash === null) return;
	const lang = doc.documentElement.lang.slice(0, 2).toLowerCase();
	const words = NOTICE[lang] ?? NOTICE.vi;
	splash.hidden = false;
	splash.setAttribute("aria-busy", "false");
	splash.classList.add("reload-notice");
	const text = splash.querySelector(".brand-loader-text") ?? splash.appendChild(doc.createElement("p"));
	text.textContent = words?.[kind] ?? "";
	if (splash.querySelector("button") !== null) return;
	const button = doc.createElement("button");
	button.type = "button";
	button.className = "btn";
	button.textContent = words?.reload ?? "";
	button.addEventListener("click", () => location.reload());
	splash.appendChild(button);
}

/**
 * Handles an error that reached the top. A failed chunk reloads once (else the
 * chunk notice); any other error shows the crash notice only when it unmounted
 * the app (`unmounted`, from React's onUncaughtError). Returns whether it acted.
 */
export function recoverFromError(error: unknown, unmounted: boolean): boolean {
	if (isChunkLoadError(error)) {
		if (!reloading && !reloadForNewBuild()) showReloadNotice("chunk");
		return true;
	}
	if (!unmounted) return false;
	showReloadNotice("crash");
	return true;
}
