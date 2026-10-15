// Registers the app shell's service worker (src/sw/service-worker.ts) in
// production builds only (the dev server serves modules, not a build), and
// tells the tab when the server has a newer build than the one it runs.
//
// A tab keeps the build it loaded until it reloads. When a new build's
// worker takes over (it does at once, see src/sw/app-shell-worker.ts), the
// tab asks it which build it caches; a different one shows the
// "Đã có bản mới · Tải lại" bar (components/update-bar.tsx). The app never
// reloads on its own: a draft or an open dialog would be lost.
import { answerBuild, askBuild, isBuildQuery, type MessageTarget } from "./sw/build-messages.ts";

/** Browsers check /sw.js on each page load; an open tab also checks this often… */
const UPDATE_CHECK_MS = 60 * 60_000;
/** …and when it comes back to the foreground, at most this often. */
const FOREGROUND_CHECK_MS = 15 * 60_000;

let updateReady = false;
const updateListeners = new Set<() => void>();

/** useSyncExternalStore pair: whether a newer build has taken over this tab's worker. */
export function subscribeAppUpdate(listener: () => void): () => void {
	updateListeners.add(listener);
	return () => updateListeners.delete(listener);
}
export function appUpdateReady(): boolean {
	return updateReady;
}

function markUpdateReady(): void {
	if (updateReady) return;
	updateReady = true;
	for (const listener of updateListeners) listener();
}

/** The entry script this tab loaded ("/assets/index-<hash>.js"), as vite-service-worker.ts finds it in index.html. */
export function pageEntry(doc: Document): string | null {
	const src = doc.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src;
	if (src === undefined || src === "") return null;
	const path = new URL(src).pathname;
	return path.startsWith("/assets/") ? path : null;
}

/** The parts of navigator.serviceWorker used to follow updates. */
export interface WorkerContainerLike {
	readonly controller: MessageTarget | null;
	addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
	addEventListener(type: "controllerchange", listener: () => void): void;
	startMessages(): void;
}

/**
 * Answers the worker's build questions (so it keeps this tab's files) and
 * marks an update when a worker of another build takes over from the one
 * that controlled this tab. The first worker taking over an uncontrolled
 * tab is no update: this tab came from the network.
 */
export function watchAppUpdates(container: WorkerContainerLike, entry: string, replyTimeoutMs?: number): void {
	container.addEventListener("message", (event) => {
		if (isBuildQuery(event.data)) answerBuild(event.ports[0], entry);
	});
	container.startMessages();
	let controlled = container.controller !== null;
	container.addEventListener("controllerchange", () => {
		const replaced = controlled;
		controlled = true;
		const worker = container.controller;
		if (worker === null) return;
		void askBuild(worker, replyTimeoutMs).then((workerEntry) => {
			// null: a worker that does not answer (an older build's, or the kill switch).
			if (replaced && workerEntry !== null && workerEntry !== entry) markUpdateReady();
		});
	});
}

export function registerServiceWorker(): void {
	if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
	const container = navigator.serviceWorker;
	const entry = pageEntry(document);
	if (entry !== null) watchAppUpdates(container, entry);
	const register = (): void => {
		container.register("/sw.js").then(
			(registration) => {
				// Asking also lets the worker drop the caches of builds no tab runs.
				if (container.controller !== null) void askBuild(container.controller);
				followUpdates(registration);
			},
			(err: unknown) => {
				// Not fatal: the app works online without it, it just cannot open offline.
				console.warn("service worker:", err);
			},
		);
	};
	// After the first load, so caching the shell does not compete with it.
	if (document.readyState === "complete") register();
	else window.addEventListener("load", register, { once: true });
}

/** Checks /sw.js while the tab stays open, so a long-open tab learns about new builds too. */
function followUpdates(registration: ServiceWorkerRegistration): void {
	let lastCheck = Date.now();
	const check = (): void => {
		lastCheck = Date.now();
		// Offline or a server error: the next check tries again.
		registration.update().catch(() => undefined);
	};
	window.setInterval(check, UPDATE_CHECK_MS);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible" && Date.now() - lastCheck >= FOREGROUND_CHECK_MS) check();
	});
}
