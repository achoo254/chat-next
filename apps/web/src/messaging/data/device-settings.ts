// Notification options kept on this device only (settings.html#notifications):
// they need no server. Read with useSyncExternalStore through useSoundInChat.
import { useSyncExternalStore } from "react";

const key = (selfId: number): string => `chat:sound-in-chat:${selfId}`;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** "Phát âm thanh khi đang mở chat": off unless the user turned it on. */
export function soundInChat(selfId: number): boolean {
	try {
		return window.localStorage.getItem(key(selfId)) === "1";
	} catch {
		return false;
	}
}

export function setSoundInChat(selfId: number, on: boolean): void {
	try {
		if (on) window.localStorage.setItem(key(selfId), "1");
		else window.localStorage.removeItem(key(selfId));
	} catch {
		// Storage off (privacy mode): the choice is not kept.
	}
	for (const listener of [...listeners]) listener();
}

export function useSoundInChat(selfId: number): boolean {
	return useSyncExternalStore(subscribe, () => soundInChat(selfId));
}
