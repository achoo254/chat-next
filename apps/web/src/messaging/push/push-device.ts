// Whether this browser gets Web Push for the signed-in user ("Thông báo khi
// đã đóng app", settings.html#notifications). Kept on the device: the
// notification filter reads it for every in-app notification, so it must not
// wait for the network. web-push-client.ts sets it once the server has the
// subscription and clears it when the subscription goes.
const key = (selfId: number): string => `chat:web-push:${selfId}`;
const listeners = new Set<() => void>();

export function pushOnDevice(selfId: number): boolean {
	try {
		return window.localStorage.getItem(key(selfId)) === "1";
	} catch {
		return false;
	}
}

export function setPushOnDevice(selfId: number, on: boolean): void {
	try {
		if (on) window.localStorage.setItem(key(selfId), "1");
		else window.localStorage.removeItem(key(selfId));
	} catch {
		// Storage off (privacy mode): pushes still arrive; in-app notifications show too.
	}
	for (const listener of [...listeners]) listener();
}

/** useSyncExternalStore subscription to changes made in this tab. */
export function subscribePushOnDevice(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
