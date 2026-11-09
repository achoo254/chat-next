// How many AI sessions wait for the user across every machine, for the
// "AI Agent" entry of the main navigation. The navigation loads at startup;
// the links (and this count) exist once the AI Agent screens have opened
// in this tab, and keep counting while the user is elsewhere in Chat. Until
// then the entry shows no badge: Web Push tells about waiting sessions.
import { useSyncExternalStore } from "react";

let needs = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Sets the count (the machines screens do, from every machine's thread list). */
export function setAgentNeeds(count: number): void {
	const next = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
	if (next === needs) return;
	needs = next;
	for (const listener of listeners) listener();
}

export function useAgentNeeds(): number {
	return useSyncExternalStore(subscribe, () => needs);
}
