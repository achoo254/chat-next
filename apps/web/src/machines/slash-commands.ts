// The composer's "/" picker as plain functions: when it opens, and which of
// the AI's commands and skills match what the user typed, the AI's own
// commands first, then the skills.
import type { SlashCommand } from "@achoo254/chat-proto/remote/remote";

/** The command name typed so far ("/rev" → "rev"); null when the text is not a command being typed. */
export function slashQuery(text: string): string | null {
	if (!text.startsWith("/")) return null;
	const query = text.slice(1);
	return /\s/.test(query) ? null : query;
}

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
