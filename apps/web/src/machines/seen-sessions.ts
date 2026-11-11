// When this device last saw each AI session (the session's updatedAt then),
// for "done, not seen yet" in the AI Agent column. A session seen for the
// first time counts as seen as it is; the open session is seen as it
// changes. Kept in this browser only, the newest 500.
import { useEffect, useSyncExternalStore } from "react";
import type { SeenMap } from "./project-tree.ts";

const KEY = "ai:seen";
const LIMIT = 500;

function read(): Map<string, number> {
	try {
		const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
		return new Map(Array.isArray(parsed) ? parsed.filter((x): x is [string, number] => Array.isArray(x) && typeof x[0] === "string" && typeof x[1] === "number") : []);
	} catch {
		return new Map();
	}
}

export interface SeenSession {
	readonly id: string;
	/** Unix ms. */
	readonly at: number;
	/** Open on this device now. */
	readonly open: boolean;
}

class SeenStore {
	private map: ReadonlyMap<string, number> | null = null;
	private readonly listeners = new Set<() => void>();

	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	readonly snapshot = (): SeenMap => {
		this.map ??= read();
		return this.map;
	};

	observe(sessions: readonly SeenSession[]): void {
		const before = this.snapshot();
		const next = new Map(before);
		for (const s of sessions) {
			if (!next.has(s.id) || (s.open && (next.get(s.id) ?? 0) < s.at)) next.set(s.id, s.at);
		}
		if (next.size === before.size && [...next].every(([id, at]) => before.get(id) === at)) return;
		const kept = [...next].slice(-LIMIT);
		this.map = new Map(kept);
		try {
			window.localStorage.setItem(KEY, JSON.stringify(kept));
		} catch {
			// Private mode: it still works on this page.
		}
		for (const listener of this.listeners) listener();
	}
}

const store = new SeenStore();

/** The seen map, recording `sessions` as they come (`key` stands for them). */
export function useSeen(sessions: readonly SeenSession[]): SeenMap {
	const key = sessions.map((s) => `${s.id}@${s.at}${s.open ? "*" : ""}`).join(",");
	useEffect(() => {
		store.observe(sessions);
		// `key` stands for the sessions.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [key]);
	return useSyncExternalStore(store.subscribe, store.snapshot);
}
