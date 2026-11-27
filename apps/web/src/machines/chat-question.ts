// A question from the Chat app's AI panel carries, before what the user typed,
// the chat's context (its first question) and the messages asked about. Each
// goes inside its own tag, which the AI reads as plain structure and the
// panel's transcript folds away, so the bubble shows only the question.

const CONTEXT_TAG = "chat_context";
const QUOTE_TAG = "quoted_messages";

function wrap(tag: string, text: string): string {
	return `<${tag}>\n${text}\n</${tag}>`;
}

/** The chat's context, as the first question of the chat's session holds it. */
export function wrapChatContext(text: string): string {
	return wrap(CONTEXT_TAG, text);
}

/** The messages a question is about. */
export function wrapQuotedMessages(text: string): string {
	return wrap(QUOTE_TAG, text);
}

export interface AskedParts {
	/** The chat's context; "" when the message has none. */
	readonly context: string;
	/** The messages asked about; "" when none. */
	readonly quote: string;
	/** What the user typed; "" for a question that is only a quote. */
	readonly question: string;
}

function take(tag: string, text: string): { readonly inner: string; readonly rest: string } | null {
	const open = `<${tag}>\n`;
	const close = `\n</${tag}>`;
	if (!text.startsWith(open)) return null;
	const end = text.indexOf(close, open.length);
	if (end < 0) return null;
	return { inner: text.slice(open.length, end), rest: text.slice(end + close.length).replace(/^\n+/, "") };
}

/** The parts of a message the panel sent; null for a message with neither tag (typed elsewhere, or before the tags). */
export function splitAsked(text: string): AskedParts | null {
	const context = take(CONTEXT_TAG, text);
	const afterContext = context?.rest ?? text;
	const quote = take(QUOTE_TAG, afterContext);
	if (context === null && quote === null) return null;
	return { context: context?.inner ?? "", quote: quote?.inner ?? "", question: (quote?.rest ?? afterContext).trim() };
}
