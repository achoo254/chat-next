// The Explorer's tree as plain data: each folder read so far (its pages of
// entries as the machine sent them, folders first in natural order), which
// folders are open, and the rows that show, flattened in display order with
// a "load more" row after a folder with more pages. Also the keyboard of
// the tree (as in Orca and VS Code): up and down move, right opens a folder
// or steps into it, left closes it or steps out to its parent, Home and End.
import type { WsDirListResult, WsEntry } from "@achoo254/chat-proto/remote/remote";

export interface DirState {
	readonly entries: readonly WsEntry[];
	readonly hasMore: boolean;
	readonly total: number;
	readonly loading: boolean;
	/** The last request failed; null otherwise. */
	readonly error: unknown;
}

export type Dirs = ReadonlyMap<string, DirState>;

export type Row =
	| { readonly kind: "entry"; readonly path: string; readonly depth: number; readonly entry: WsEntry; readonly parent: string }
	| { readonly kind: "more"; readonly path: string; readonly depth: number; readonly parent: string; readonly shown: number; readonly total: number }
	| { readonly kind: "loading" | "empty" | "error"; readonly path: string; readonly depth: number; readonly parent: string; readonly error?: unknown };

/** The path of `name` in folder `dir` ("" is the workspace's root). */
export function childPath(dir: string, name: string): string {
	return dir === "" ? name : `${dir}/${name}`;
}

/** The folder holding `path` ("" for a top-level entry). */
export function parentOf(path: string): string {
	const cut = path.lastIndexOf("/");
	return cut < 0 ? "" : path.slice(0, cut);
}

/** The last part of a path. */
export function baseName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

/** A folder whose first page is being asked for (keeps what it had, so a refresh does not flicker). */
export function startLoading(dirs: Dirs, dir: string): Dirs {
	const next = new Map(dirs);
	const prev = dirs.get(dir);
	next.set(dir, { entries: prev?.entries ?? [], hasMore: prev?.hasMore ?? false, total: prev?.total ?? 0, loading: true, error: null });
	return next;
}

/** A page arrived: the first page replaces the folder's entries, a later one adds to them. */
export function applyPage(dirs: Dirs, result: Pick<WsDirListResult, "path" | "entries" | "hasMore" | "total">, append: boolean): Dirs {
	const next = new Map(dirs);
	const prev = dirs.get(result.path);
	const kept = append ? (prev?.entries ?? []) : [];
	// A page that starts after an entry never repeats it; drop any that did (a folder renamed meanwhile).
	const seen = new Set(kept.map((e) => e.name));
	const entries = [...kept, ...result.entries.filter((e) => !seen.has(e.name))];
	next.set(result.path, { entries, hasMore: result.hasMore, total: Math.max(result.total, entries.length), loading: false, error: null });
	return next;
}

/** The request for a folder failed. */
export function failLoading(dirs: Dirs, dir: string, error: unknown): Dirs {
	const next = new Map(dirs);
	const prev = dirs.get(dir);
	next.set(dir, { entries: prev?.entries ?? [], hasMore: prev?.hasMore ?? false, total: prev?.total ?? 0, loading: false, error });
	return next;
}

/** Where the next page of a folder starts: after its last entry. */
export function nextCursor(state: DirState | undefined): { afterName: string; afterDir: boolean } {
	const last = state?.entries.at(-1);
	return last === undefined ? { afterName: "", afterDir: false } : { afterName: last.name, afterDir: last.dir };
}

/** Folders that are open and read: the ones to read again after a change. */
export function loadedOpenDirs(dirs: Dirs, expanded: ReadonlySet<string>): string[] {
	return [...dirs.keys()].filter((dir) => dir === "" || (expanded.has(dir) && isVisible(dir, expanded)));
}

/** Every folder above `path` is open. */
function isVisible(path: string, expanded: ReadonlySet<string>): boolean {
	for (let dir = parentOf(path); dir !== ""; dir = parentOf(dir)) if (!expanded.has(dir)) return false;
	return true;
}

/** The rows that show, in order: each entry, the contents of open folders beneath it, and a row for a folder's state. */
export function visibleRows(dirs: Dirs, expanded: ReadonlySet<string>, root = ""): Row[] {
	const rows: Row[] = [];
	const walk = (dir: string, depth: number) => {
		const state = dirs.get(dir);
		if (state === undefined || (state.loading && state.entries.length === 0)) {
			rows.push({ kind: "loading", path: `${dir}\u0000loading`, depth, parent: dir });
			return;
		}
		if (state.error !== null && state.entries.length === 0) {
			rows.push({ kind: "error", path: `${dir}\u0000error`, depth, parent: dir, error: state.error });
			return;
		}
		if (state.entries.length === 0) {
			rows.push({ kind: "empty", path: `${dir}\u0000empty`, depth, parent: dir });
			return;
		}
		for (const entry of state.entries) {
			const path = childPath(dir, entry.name);
			rows.push({ kind: "entry", path, depth, entry, parent: dir });
			if (entry.dir && expanded.has(path)) walk(path, depth + 1);
		}
		if (state.hasMore) rows.push({ kind: "more", path: `${dir}\u0000more`, depth, parent: dir, shown: state.entries.length, total: state.total });
	};
	walk(root, 0);
	return rows;
}

export type TreeAction =
	| { readonly kind: "focus"; readonly index: number }
	| { readonly kind: "expand"; readonly path: string }
	| { readonly kind: "collapse"; readonly path: string }
	| { readonly kind: "open"; readonly path: string }
	| { readonly kind: "more"; readonly dir: string };

/** What a key does on the row at `index`; null when the tree does not handle it. */
export function treeKey(rows: readonly Row[], index: number, key: string, expanded: ReadonlySet<string>): TreeAction | null {
	const row = rows[index];
	if (row === undefined) return rows.length > 0 ? { kind: "focus", index: 0 } : null;
	switch (key) {
		case "ArrowDown":
			return { kind: "focus", index: Math.min(rows.length - 1, index + 1) };
		case "ArrowUp":
			return { kind: "focus", index: Math.max(0, index - 1) };
		case "Home":
			return { kind: "focus", index: 0 };
		case "End":
			return { kind: "focus", index: rows.length - 1 };
		case "ArrowRight":
			if (row.kind !== "entry" || !row.entry.dir) return null;
			if (!expanded.has(row.path)) return { kind: "expand", path: row.path };
			// Open already: step onto its first row.
			return index + 1 < rows.length ? { kind: "focus", index: index + 1 } : null;
		case "ArrowLeft": {
			if (row.kind === "entry" && row.entry.dir && expanded.has(row.path)) return { kind: "collapse", path: row.path };
			if (row.parent === "") return null;
			const parent = rows.findIndex((r) => r.kind === "entry" && r.path === row.parent);
			return parent < 0 ? null : { kind: "focus", index: parent };
		}
		case "Enter":
		case " ":
			if (row.kind === "more") return { kind: "more", dir: row.parent };
			if (row.kind !== "entry") return null;
			if (row.entry.dir) return expanded.has(row.path) ? { kind: "collapse", path: row.path } : { kind: "expand", path: row.path };
			return { kind: "open", path: row.path };
		default:
			return null;
	}
}
