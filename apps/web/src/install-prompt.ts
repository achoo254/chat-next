// Installing the web app (settings "Cài ứng dụng", mockups/settings.html#app).
// Chromium browsers announce that the app can be installed once, early, with
// beforeinstallprompt: captureInstallPrompt runs at startup (main.tsx) and
// keeps that event so the settings button can show the browser's own install
// dialog later. Safari on iPhone and iPad has no such event: the user adds
// the app to the home screen by hand, and only an app opened from there
// gets Web Push.
import { IS_NATIVE } from "./server-origin.ts";

/** The Chromium event; not in the DOM typings. */
interface BeforeInstallPromptEvent extends Event {
	prompt(): Promise<void>;
	readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/**
 * - installed: this window is the installed app;
 * - prompt: the browser's install dialog can be opened;
 * - ios: Safari on iPhone or iPad, add to the home screen by hand;
 * - manual: the browser's menu, if it can install at all.
 */
export type InstallState = "installed" | "prompt" | "ios" | "manual";

let deferred: BeforeInstallPromptEvent | null = null;
let installedNow = false;
const listeners = new Set<() => void>();

function changed(): void {
	for (const listener of [...listeners]) listener();
}

/** The window runs as the installed app (home screen, app window). */
export function isStandalone(): boolean {
	if ((navigator as Navigator & { standalone?: boolean }).standalone === true) return true;
	return typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches;
}

/** Safari on iPhone or iPad (iPadOS reports a Mac with touch). */
export function isAppleMobile(): boolean {
	return /iPad|iPhone|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

export function captureInstallPrompt(): void {
	window.addEventListener("beforeinstallprompt", (event) => {
		// Keep it for the settings button instead of the browser's mini bar.
		event.preventDefault();
		deferred = event as BeforeInstallPromptEvent;
		changed();
	});
	window.addEventListener("appinstalled", () => {
		deferred = null;
		installedNow = true;
		changed();
	});
}

export function installState(): InstallState {
	// The iOS and Android apps are installed by definition.
	if (IS_NATIVE || installedNow || isStandalone()) return "installed";
	if (deferred !== null) return "prompt";
	return isAppleMobile() ? "ios" : "manual";
}

/** useSyncExternalStore subscription. */
export function subscribeInstall(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Opens the browser's install dialog; the event can be used once. */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
	const event = deferred;
	if (event === null) return "unavailable";
	deferred = null;
	changed();
	await event.prompt();
	return (await event.userChoice).outcome;
}
