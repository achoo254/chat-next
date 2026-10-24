// Integration alerts (mockups/integrations.html#alert-message): a first line
// that starts with the word "Firing" or "Resolved" becomes a status chip and
// the title; the other lines stay exactly as sent ("emoji label: value"
// fields, code blocks). Entities are cut to each piece (UTF-16 offsets).
import type { MessageEntity } from "@achoo254/chat-core";

export type AlertStatus = "firing" | "resolved";

export interface RichPiece {
	readonly text: string;
	readonly entities: readonly MessageEntity[];
}

export interface AlertParts {
	readonly status: AlertStatus;
	/** The rest of the first line, after the status word. */
	readonly title: RichPiece;
	/** Every line after the first; empty when the alert is one line. */
	readonly body: RichPiece;
}

/** The status word, then spaces; only as a whole word. */
const STATUS = /^(firing|resolved)(?=\s|$)[ \t]*/i;

/** `text` from `start` to `end`, with the entities that overlap it clipped to it. */
export function sliceRich(text: string, entities: readonly MessageEntity[], start: number, end: number): RichPiece {
	const clipped: MessageEntity[] = [];
	for (const entity of entities) {
		const from = Math.max(entity.offset, start);
		const to = Math.min(entity.offset + entity.length, end);
		if (to > from) clipped.push({ ...entity, offset: from - start, length: to - from });
	}
	return { text: text.slice(start, end), entities: clipped };
}

/** The status, title and body of an alert, or null when the text does not start with a status word. */
export function splitAlert(text: string, entities: readonly MessageEntity[]): AlertParts | null {
	const match = STATUS.exec(text);
	const word = match?.[1];
	if (match === null || word === undefined) return null;
	const newline = text.indexOf("\n");
	const titleEnd = newline < 0 ? text.length : newline;
	return {
		status: word.toLowerCase() === "firing" ? "firing" : "resolved",
		title: sliceRich(text, entities, match[0].length, titleEnd),
		body: newline < 0 ? { text: "", entities: [] } : sliceRich(text, entities, newline + 1, text.length),
	};
}
