// What "Phiên mới" offers before the user types anything: the folders the
// machine's sessions ran in (newest first, then the machine's own recent
// list), and ready first messages so "Bắt đầu" works straight away.
import type { ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import type { MachinesCopy } from "./copy-vi.ts";

export const PROMPT_HINTS = ["summary", "commit", "test", "resume"] as const;
export type PromptHint = (typeof PROMPT_HINTS)[number];

const RECENT_LIMIT = 6;

/** Distinct folders of the machine's sessions, newest first, then the machine's recent folders. */
export function recentFolders(threads: readonly ThreadSummary[], machineRecent: readonly string[] = []): string[] {
	const byNewest = [...threads].sort((a, b) => (a.updatedAt === b.updatedAt ? 0 : a.updatedAt > b.updatedAt ? -1 : 1));
	const dirs = [...byNewest.map((thread) => thread.dir), ...machineRecent].map((dir) => dir.trim()).filter((dir) => dir !== "");
	return [...new Set(dirs)].slice(0, RECENT_LIMIT);
}

/** The last segment of a path ("D:\\x\\chat-next" or "/x/chat-next" → "chat-next"). */
export function folderName(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/** The first message a hint stands for, about the chosen folder. */
export function hintPrompt(copy: MachinesCopy["newSession"], hint: PromptHint, path: string): string {
	return hint === "summary" ? copy.prompt.summary(folderName(path.trim())) : copy.prompt[hint];
}

/** Folders under home that macOS gives only to apps with Full Disk Access (or after a prompt). */
const DISK_ACCESS_FOLDERS = ["Desktop", "Documents", "Downloads", "Library"];

/** True for a folder a session on a Mac without Full Disk Access cannot use freely. */
export function inDiskAccessFolder(dir: string, home: string): boolean {
	if (dir === "" || home === "") return false;
	const h = home.replace(/\/+$/, "");
	const d = dir.replace(/^~(?=\/|$)/, h).replace(/\/+$/, "");
	return DISK_ACCESS_FOLDERS.some((name) => d === `${h}/${name}` || d.startsWith(`${h}/${name}/`));
}

export interface Crumb {
	readonly name: string;
	readonly path: string;
}

/**
 * The folders of a path, each with its own full path, for a breadcrumb that
 * goes to any of them. Under the home folder it starts at home.
 */
export function pathCrumbs(path: string, home: string): Crumb[] {
	const windows = /^[A-Za-z]:/.test(path);
	const sep = windows ? "\\" : "/";
	const crumbs: Crumb[] = [];
	let at = "";
	for (const name of path.split(/[\\/]/).filter((part) => part !== "")) {
		at = at === "" ? (windows ? `${name}${sep}` : `${sep}${name}`) : at.endsWith(sep) ? `${at}${name}` : `${at}${sep}${name}`;
		crumbs.push({ name, path: at });
	}
	const clean = (p: string) => p.replace(/[\\/]+$/, "");
	const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
	const homeAt = home === "" ? -1 : crumbs.findIndex((c) => same(clean(c.path), clean(home)));
	return homeAt > 0 ? crumbs.slice(homeAt) : crumbs;
}

/** `path` is the machine's home folder (trailing separators and, on Windows, letter case aside). */
export function isHome(path: string, home: string): boolean {
	if (home === "" || path.trim() === "") return false;
	const clean = (p: string) => p.trim().replace(/[\\/]+$/, "");
	const a = clean(path);
	const b = clean(home);
	return a === b || (/^[A-Za-z]:/.test(b) && a.toLowerCase() === b.toLowerCase()) || a === "~";
}
