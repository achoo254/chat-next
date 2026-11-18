// The composer's "/" picker as plain functions: which of the AI's commands
// and skills match what the user typed, the AI's own commands first, then
// the skills (commandToken in components/plain-text-box.tsx says when it opens).
import type { SlashCommand } from "@achoo254/chat-proto/remote/remote";

export interface CommandGroups {
	readonly builtin: readonly SlashCommand[];
	readonly skills: readonly SlashCommand[];
}

/** Commands whose name contains `query` (case-insensitive), names starting with it first. */
export function filterCommands(commands: readonly SlashCommand[], query: string): CommandGroups {
	const q = query.toLowerCase();
	const rank = (c: SlashCommand) => (c.name.toLowerCase().startsWith(q) ? 0 : 1);
	const matching = commands
		.filter((c) => c.name !== "" && c.name.toLowerCase().includes(q))
		.map((c, i) => ({ c, i }))
		.sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
		.map(({ c }) => c);
	return { builtin: matching.filter((c) => c.builtin), skills: matching.filter((c) => !c.builtin) };
}

/** The groups in keyboard order. */
export function flatCommands(groups: CommandGroups): SlashCommand[] {
	return [...groups.builtin, ...groups.skills];
}

/** A command name as the AIs name theirs ("clear", "ak-cook", "plugin:skill"); a path ("/Users/x") is not one. */
const COMMAND_AT_START = /^\/([A-Za-z0-9][\w:.-]*)(?=\s|$)/;

/**
 * The length of the "/command" a message starts with, 0 when it starts with
 * none. Once the AI's commands are known, only one of them counts.
 */
export function leadingCommand(text: string, commands: readonly SlashCommand[]): number {
	const match = COMMAND_AT_START.exec(text);
	if (match === null) return 0;
	const name = match[1] ?? "";
	if (commands.length > 0 && !commands.some((c) => c.name === name)) return 0;
	return name.length + 1;
}
