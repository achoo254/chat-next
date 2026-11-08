/**
 * The one filter for every string that leaves tunelo's MCP side (tool
 * results, errors, tool lists, `tunelo mcp` stderr, log lines): no token
 * this service sent, nothing shaped like a JWT, no `Bearer <value>`, even
 * when a server or a proxy in front of it echoes them back. A JWT the user
 * really wrote in a message is hidden too: the rule cannot tell them apart.
 */

/** A JWT, whole or cut: base64url JSON (`eyJ` is `{"`) and up to two more segments. */
const JWT = /eyJ[\w-]{8,}(?:\.[\w-]*){0,2}/g;
const BEARER = /\b(Bearer)\s+[^\s"'\\,;]+/gi;
const HIDDEN = "[hidden]";

/** Error and log text is cut to this many characters. */
export const MAX_MESSAGE_CHARS = 500;

/** `text` without the `known` tokens, JWTs or Bearer values. */
export function redact(text: string, known: Iterable<string> = []): string {
	let out = text;
	for (const token of known) if (token) out = out.split(token).join(HIDDEN);
	return out.replace(JWT, HIDDEN).replace(BEARER, `$1 ${HIDDEN}`);
}

/** An error or log message: redacted, then cut. */
export function redactMessage(text: string, known: Iterable<string> = []): string {
	const clean = redact(text, known);
	return clean.length > MAX_MESSAGE_CHARS ? `${clean.slice(0, MAX_MESSAGE_CHARS)}…` : clean;
}

const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|apikey|x-auth-token|x-access-token|x-csrf-token|x-xsrf-token)$/i;

/**
 * JSON text with the values of sensitive HTTP headers hidden, wherever they
 * appear: `{ name, value }` pairs and `{ "<header>": value }` maps. Text
 * that is not JSON is returned as is (redact still applies to it).
 */
export function hideSensitiveHeaders(text: string): string {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return text;
	}
	const walk = (node: unknown): unknown => {
		if (Array.isArray(node)) return node.map(walk);
		if (typeof node !== "object" || node === null) return node;
		const record = node as Record<string, unknown>;
		const named = typeof record.name === "string" && SENSITIVE_HEADER.test(record.name) && "value" in record;
		const out: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(record)) {
			if (named && key === "value") out[key] = HIDDEN;
			else if (SENSITIVE_HEADER.test(key) && (typeof child === "string" || Array.isArray(child))) out[key] = HIDDEN;
			else out[key] = walk(child);
		}
		return out;
	};
	return JSON.stringify(walk(value));
}
