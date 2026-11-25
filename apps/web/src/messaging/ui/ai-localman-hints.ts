// Whether a message carries a request Localman could run or keep: a curl
// command, an http(s) URL or a JSON object or array (in a fenced block, as
// code, or as the whole text). The AI panel's quote card offers «Chạy bằng
// Localman» and «Lưu vào collection» only then; plain prose gets neither.

/** "curl" followed by a flag or an address ("mình curl tóc" is prose). */
const CURL = /(?:^|[\s`$>])curl\s+(?:-{1,2}[a-z]|['"]?(?:https?:\/\/|localhost\b|\d{1,3}\.\d|[\w-]+(?:\.[\w-]+)+[:/]|\{\{))/i;
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`]+/i;
const FENCE = /```[^\n`]*\n?([\s\S]*?)```/g;
const INLINE_CODE = /`([^`\n]+)`/g;

/** A JSON object with a key, or a non-empty array. */
function isJson(text: string): boolean {
	const trimmed = text.trim();
	if (!(trimmed.startsWith("{") && trimmed.endsWith("}")) && !(trimmed.startsWith("[") && trimmed.endsWith("]"))) return false;
	try {
		const value: unknown = JSON.parse(trimmed);
		if (Array.isArray(value)) return value.length > 0;
		return typeof value === "object" && value !== null && Object.keys(value).length > 0;
	} catch {
		return false;
	}
}

/** The JSON a text holds: the whole text, a code block or span, or its outermost {…} / […]. */
function holdsJson(text: string): boolean {
	if (isJson(text)) return true;
	for (const match of text.matchAll(FENCE)) if (isJson(match[1] ?? "")) return true;
	for (const match of text.matchAll(INLINE_CODE)) if (isJson(match[1] ?? "")) return true;
	for (const [open, close] of [
		["{", "}"],
		["[", "]"],
	] as const) {
		const start = text.indexOf(open);
		const end = text.lastIndexOf(close);
		if (start >= 0 && end > start && isJson(text.slice(start, end + 1))) return true;
	}
	return false;
}

/**
 * Whether the message offers Localman's quick actions. `code`: the message's
 * code and pre spans (Telegram entities), looked at like fenced blocks.
 */
export function hasLocalmanRequest(text: string, code: readonly string[] = []): boolean {
	return [text, ...code].some((part) => CURL.test(part) || URL_IN_TEXT.test(part) || holdsJson(part));
}
