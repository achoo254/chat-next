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
