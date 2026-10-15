// Registers the app shell's service worker (src/sw/service-worker.ts) in
// production builds only: the dev server serves modules, not a build.
export function registerServiceWorker(): void {
	if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
	const register = (): void => {
		navigator.serviceWorker.register("/sw.js").catch((err: unknown) => {
			// Not fatal: the app works online without it, it just cannot open offline.
			console.warn("service worker:", err);
		});
	};
	// After the first load, so caching the shell does not compete with it.
	if (document.readyState === "complete") register();
	else window.addEventListener("load", register, { once: true });
}
