// A tool call as a plain step, for the Chat app's AI panel: "Tìm tin trong
// chat" instead of "mcp__tunelo__chat_search_messages". The AI Agent screens
// keep the tools' own names.
import type { MachinesCopy } from "../copy-vi.ts";

type StepCopy = MachinesCopy["transcript"]["step"];
type StepKey = Exclude<keyof StepCopy, "other">;

/** tunelo's chat tools, by their name without the server's prefix and without "chat_". */
const CHAT_TOOLS: Readonly<Record<string, StepKey>> = {
	search_messages: "chatSearch",
	get_messages: "chatRead",
	get_chat: "chatInfo",
	list_chats: "chatList",
	send_message: "chatSend",
	send_file: "chatSendFile",
};

/** The AIs' own tools (Claude Code's names; others fall to "other"). */
const OWN_TOOLS: Readonly<Record<string, StepKey>> = {
	bash: "shell",
	read: "readFile",
	notebookread: "readFile",
	edit: "editFile",
	multiedit: "editFile",
	write: "editFile",
	notebookedit: "editFile",
	grep: "searchFiles",
	glob: "searchFiles",
	ls: "searchFiles",
	webfetch: "web",
	websearch: "web",
};

/** A tool's name as a step the user reads. */
export function toolStep(name: string, copy: StepCopy): string {
	// "mcp__<server>__<tool>": the tool's own name.
	const bare = name.startsWith("mcp__") ? name.split("__").slice(2).join("__") || name : name;
	const chat = bare.startsWith("chat_") ? CHAT_TOOLS[bare.slice("chat_".length)] : undefined;
	if (chat !== undefined) return copy[chat];
	const own = OWN_TOOLS[bare.toLowerCase()];
	if (own !== undefined) return copy[own];
	return copy.other(bare.replace(/_/g, " "));
}
