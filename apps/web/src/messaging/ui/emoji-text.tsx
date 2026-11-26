// Emoji drawn at Telegram's sizes: a little larger than the text inside a message
// (.emoji), and a message of one to three emoji alone shown big without its bubble
// (jumboCount). Only what shows as an emoji counts: a pictograph with emoji presentation
// or followed by U+FE0F, with its skin tone and joined parts, a flag, a keycap; a © or ™
// stays text.
import type { ReactNode } from "react";

const PART = String.raw`(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}️)\p{Emoji_Modifier}?`;
const JOINED = String.raw`‍\p{Extended_Pictographic}️?\p{Emoji_Modifier}?`;
const EMOJI = new RegExp(String.raw`\p{Regional_Indicator}{2}|[#*0-9]️?⃣|${PART}(?:${JOINED})*`, "gu");

/** The most emoji a message may hold alone and still be shown big. */
const JUMBO_MAX = 3;

/** How many emoji a message is made of when it holds nothing else (1 to 3); 0 otherwise. */
export function jumboCount(text: string): number {
	const trimmed = text.replace(/\s+/g, "");
	if (trimmed === "") return 0;
	const found = trimmed.match(EMOJI) ?? [];
	if (found.length > JUMBO_MAX || found.join("") !== trimmed) return 0;
	return found.length;
}

/** The text with each emoji in a span.emoji, drawn larger than the letters; the text itself when it has none. */
export function withEmoji(text: string): ReactNode {
	// search, not test: it leaves the shared global pattern's lastIndex alone for matchAll.
	if (text.search(EMOJI) === -1) return text;
	const out: ReactNode[] = [];
	let cursor = 0;
	for (const match of text.matchAll(EMOJI)) {
		if (match.index > cursor) out.push(text.slice(cursor, match.index));
		out.push(
			<span className="emoji" key={match.index}>
				{match[0]}
			</span>,
		);
		cursor = match.index + match[0].length;
	}
	if (cursor < text.length) out.push(text.slice(cursor));
	return out;
}
