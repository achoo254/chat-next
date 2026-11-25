// Reactions on a chat synced with another app: the app takes only some emoji, so
// the pickers offer only those and a refusal says so instead of "did not work".
// The Telegram list is the one the server checks (server/internal/bridge/feature/reactions.go).
import { Code, ConnectError } from "@connectrpc/connect";

const TELEGRAM = [
	"❤", "👍", "👎", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉", "🤩", "🤮", "💩", "🙏", "👌", "🕊",
	"🤡", "🥱", "🥴", "😍", "🐳", "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓", "🍾",
	"💋", "🖕", "😈", "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈", "😇", "😨", "🤝", "✍", "🤗", "🫡", "🎅",
	"🎄", "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄", "😘", "💊", "🙊", "😎", "👾", "🤷‍♂", "🤷", "🤷‍♀", "😡",
];

// Zalo's set (server/internal/bridge/feature/reactions.go).
const ZALO = [
	"❤", "👍", "😆", "😮", "😢", "😡", "😘", "😂", "💩", "🌹", "💔", "👎", "😍", "😕", "😉", "🥀", "☀", "🎂", "💣", "👌", "✌", "🤝", "👊", "🔗", "🙏", "🙅", "🤏", "🤟", "😔", "😭", "😎", "🤓", "😁", "😐", "😞", "👋", "😴", "😅", "🤦", "😫", "👏", "😠", "🤐", "😲", "😳", "😨", "😟", "🤣", "🤑", "🍺",
];

/** What each app takes; an app not here takes any emoji. */
const TAKEN: Readonly<Record<string, ReadonlySet<string>>> = { telegram: new Set(TELEGRAM), zalo: new Set(ZALO) };

/** The closest emoji an app has for one of the quick row's that it lacks. */
const CLOSEST: Readonly<Record<string, string>> = { "😂": "🤣", "😮": "😱" };

const bare = (emoji: string) => emoji.replaceAll("️", "");

/** Whether a chat synced with `app` (undefined: a plain chat) takes this emoji as a reaction. */
export function reactionTaken(app: string | undefined, emoji: string): boolean {
	const taken = app === undefined ? undefined : TAKEN[app];
	return taken === undefined || taken.has(bare(emoji));
}

/** The quick row for a chat: each emoji, or its closest the app takes, once. */
export function quickReactions(app: string | undefined, emojis: readonly string[]): string[] {
	const out: string[] = [];
	for (const emoji of emojis) {
		const pick = reactionTaken(app, emoji) ? emoji : (CLOSEST[emoji] ?? "");
		if (pick !== "" && reactionTaken(app, pick) && !out.includes(pick)) out.push(pick);
	}
	return out;
}

/** True when the server refused a reaction because the synced app does not take the emoji. */
export function isReactionRefused(err: unknown): boolean {
	const error = ConnectError.from(err);
	return error.code === Code.InvalidArgument && error.rawMessage.startsWith("reaction_not_accepted");
}
