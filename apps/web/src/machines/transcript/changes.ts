// The files the AI changed in a session, from the diffs in its journal: one
// entry per path (in the order first changed) with every edit of it and the
// lines added and removed in total. Edits made outside the AI are not in the
// journal, so they are not here either.
import type { DiffItem, Item } from "@achoo254/chat-proto/remote/remote";

export interface FileEdit {
	/** The diff item's id, to fetch it in full. */
	readonly id: string;
	readonly diff: DiffItem;
}

export interface FileChange {
	readonly path: string;
	readonly added: number;
	readonly removed: number;
	readonly edits: readonly FileEdit[];
}

export function sessionChanges(items: readonly Item[]): FileChange[] {
	const byPath = new Map<string, { added: number; removed: number; edits: FileEdit[] }>();
	for (const item of items) {
		if (item.body.case !== "diff") continue;
		const diff = item.body.value;
		const entry = byPath.get(diff.path) ?? { added: 0, removed: 0, edits: [] };
		entry.added += diff.added;
		entry.removed += diff.removed;
		entry.edits.push({ id: item.id, diff });
		byPath.set(diff.path, entry);
	}
	return [...byPath].map(([path, entry]) => ({ path, ...entry }));
}
