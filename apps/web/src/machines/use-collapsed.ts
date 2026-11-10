import { useState } from "react";

const KEY = "ai:collapsed";

/** The ids folded in this browser; a per-viewer convenience, so any storage failure reads as "nothing folded". */
function readFolded(): Set<string> {
	try {
		const raw = window.localStorage.getItem(KEY);
		const parsed: unknown = raw === null ? [] : JSON.parse(raw);
		return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
	} catch {
		return new Set();
	}
}

/** Whether the group `id` is folded, and a toggle that remembers the choice. Groups start unfolded. */
export function useCollapsed(id: string): [boolean, () => void] {
	const [collapsed, setCollapsed] = useState(() => readFolded().has(id));
	const toggle = () => {
		const next = !collapsed;
		setCollapsed(next);
		const folded = readFolded();
		if (next) folded.add(id);
		else folded.delete(id);
		try {
			window.localStorage.setItem(KEY, JSON.stringify([...folded]));
		} catch {
			// Private mode: the fold still applies on this page.
		}
	};
	return [collapsed, toggle];
}
