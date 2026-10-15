// Kill switch for the web app's service worker (apps/web/src/sw). Served
// as /sw.js in place of a build's worker (docs/deployment-guide.md,
// "Service worker: kill switch"), it takes over at once, deletes the app
// shell caches and unregisters itself. It has no fetch handler, so while it
// still controls an open tab every request goes to the network. Tabs are
// not reloaded (no lost drafts); they run without a worker from their next
// load. The app registers /sw.js on each load, so while this file is served
// each load installs it again and it removes itself again: harmless.
/* global self, caches */
"use strict";

/** Prefix of the app shell caches (CACHE_PREFIX in apps/web/src/sw/shell-routes.ts). */
const SHELL_CACHE_PREFIX = "app-shell-";

self.addEventListener("install", () => {
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			const keys = await caches.keys();
			await Promise.all(keys.filter((key) => key.startsWith(SHELL_CACHE_PREFIX)).map((key) => caches.delete(key)));
			await self.registration.unregister();
		})(),
	);
});
