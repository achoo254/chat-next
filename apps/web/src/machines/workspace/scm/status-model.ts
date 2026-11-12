// Source Control's view of git's status (WsGitStatusResult), as plain data:
// the entries split into conflicts, staged and not staged (untracked files
// with the unstaged ones), each grouped by folder and sorted by path; which
// of them a stage, a commit or a discard takes in, and the secret files
// among those (they need the user's consent, named, before git takes them).
import { WsGitArea, type WsGitEntry } from "@achoo254/chat-proto/remote/remote";
import { parentOf } from "../explorer/tree-model.ts";

export type AreaKey = "conflicted" | "staged" | "unstaged";

export interface FolderGroup {
	/** Relative to the workspace; "" for its top folder. */
	readonly folder: string;
	readonly entries: readonly WsGitEntry[];
}

export interface AreaGroup {
	readonly area: AreaKey;
	readonly count: number;
	readonly folders: readonly FolderGroup[];
}

export function areaOf(entry: Pick<WsGitEntry, "area">): AreaKey {
	switch (entry.area) {
		case WsGitArea.CONFLICTED:
			return "conflicted";
		case WsGitArea.STAGED:
			return "staged";
		default:
			return "unstaged";
	}
}

const ORDER: readonly AreaKey[] = ["conflicted", "staged", "unstaged"];

/** Entries by folder, folders and files by path; "" (the top folder) first. */
export function byFolder(entries: readonly WsGitEntry[]): FolderGroup[] {
	const folders = new Map<string, WsGitEntry[]>();
	for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
		const folder = parentOf(entry.path);
		const list = folders.get(folder);
		if (list === undefined) folders.set(folder, [entry]);
		else list.push(entry);
	}
	return [...folders.entries()].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b))).map(([folder, list]) => ({ folder, entries: list }));
}

/** The non-empty areas in order (conflicts, staged, not staged), each grouped by folder. */
export function groupStatus(entries: readonly WsGitEntry[]): AreaGroup[] {
	return ORDER.flatMap((area) => {
		const mine = entries.filter((e) => areaOf(e) === area);
		return mine.length === 0 ? [] : [{ area, count: mine.length, folders: byFolder(mine) }];
	});
}

/** The groups cut to their first `max` entries in display order (for "View all"). */
export function limitGroups(groups: readonly AreaGroup[], max: number): AreaGroup[] {
	let left = max;
	const out: AreaGroup[] = [];
	for (const group of groups) {
		if (left <= 0) break;
		const folders: FolderGroup[] = [];
		for (const folder of group.folders) {
			if (left <= 0) break;
			const entries = folder.entries.slice(0, left);
			left -= entries.length;
			folders.push({ folder: folder.folder, entries });
		}
		out.push({ ...group, folders });
	}
	return out;
}

/** Entries "Stage" takes in: everything not staged yet (unstaged, untracked, conflicted). */
export function unstagedEntries(entries: readonly WsGitEntry[]): WsGitEntry[] {
	return entries.filter((e) => areaOf(e) !== "staged");
}

export function stagedEntries(entries: readonly WsGitEntry[]): WsGitEntry[] {
	return entries.filter((e) => areaOf(e) === "staged");
}

/** Entries a discard throws away: working-tree changes and untracked files (staged changes stay). */
export function discardableEntries(entries: readonly WsGitEntry[]): WsGitEntry[] {
	return entries.filter((e) => e.area === WsGitArea.UNSTAGED || e.area === WsGitArea.UNTRACKED);
}

/** The secret files among `entries`, by path, once each. */
export function sensitivePaths(entries: readonly WsGitEntry[]): string[] {
	return [...new Set(entries.filter((e) => e.sensitive).map((e) => e.path))];
}

/** Of `paths`, those that are untracked (a discard moves them to the Trash) and those tracked (it cannot be undone). */
export function discardKinds(entries: readonly WsGitEntry[], paths: readonly string[]): { untracked: number; tracked: number } {
	const wanted = new Set(paths);
	let untracked = 0;
	let tracked = 0;
	for (const entry of discardableEntries(entries)) {
		if (!wanted.has(entry.path)) continue;
		if (entry.area === WsGitArea.UNTRACKED) untracked++;
		else tracked++;
	}
	return { untracked, tracked };
}
