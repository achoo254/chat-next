// The device keys of "My machines" (ADR 0013): this browser's X25519 key and
// the machine keys it pinned, kept in one IndexedDB database by the web app
// (apps/web/src/machines/link/device-keys.ts). They belong to the signed-in
// session like the local database, so ending the session deletes them too.

/** Name of the IndexedDB database holding the device keys. */
export const DEVICE_KEYS_DATABASE = "machine-device-keys";

interface DeleteRequestLike {
	onsuccess: (() => void) | null;
	onerror: (() => void) | null;
	onblocked: (() => void) | null;
}

interface IndexedDbLike {
	deleteDatabase(name: string): DeleteRequestLike;
}

/**
 * Deletes the device keys database. Resolves once the deletion succeeded,
 * failed, or is queued behind a connection still open in a tab (the browser
 * finishes it when that tab closes its connection, which the web app does on
 * the versionchange event). A platform without IndexedDB has nothing to wipe.
 */
export function wipeDeviceKeys(indexedDb: IndexedDbLike | undefined = (globalThis as { indexedDB?: IndexedDbLike }).indexedDB): Promise<void> {
	if (indexedDb === undefined) return Promise.resolve();
	return new Promise((resolve) => {
		let request: DeleteRequestLike;
		try {
			request = indexedDb.deleteDatabase(DEVICE_KEYS_DATABASE);
		} catch {
			// Storage disabled (private mode in some browsers): nothing was kept.
			resolve();
			return;
		}
		request.onsuccess = () => resolve();
		request.onerror = () => resolve();
		request.onblocked = () => resolve();
	});
}
