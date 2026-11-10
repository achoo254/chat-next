// The rule of bots' inline mode: "@bot_username " at the start of the draft,
// and the query is the rest of the draft (spaces and line breaks included).
// The composer's message box finds the token with it, as Telegram Web A finds
// its inline bot token as the whole text; the results (inline-results.tsx)
// read the bot and the query from that token. Kept apart from the results so
// the composer carries only this rule until the first such draft.
import type { TokenMatch } from "../../components/plain-text-box.tsx";

/** "@bot_username query": a username as Telegram allows it, one space, then anything. */
const DRAFT = /^@([A-Za-z0-9_]{5,32}) ([^]*)$/;

/** The bot and the query of an inline mode draft. */
export interface InlineDraft {
	/** The bot's username as typed (without "@"). */
	readonly username: string;
	/** Everything after the space that follows the username; "" right after it. */
	readonly query: string;
}

/** The bot and the query when the whole draft is "@bot_username query"; null otherwise. */
export function inlineDraft(value: string): InlineDraft | null {
	const match = DRAFT.exec(value);
	const username = match?.[1];
	if (match === null || username === undefined) return null;
	return { username, query: match[2] ?? "" };
}

/** The inline mode token: the whole draft, wherever the caret is in it; its query is what follows "@". */
export function inlineToken(value: string): TokenMatch | null {
	return inlineDraft(value) === null ? null : { start: 0, end: value.length, query: value.slice(1) };
}
