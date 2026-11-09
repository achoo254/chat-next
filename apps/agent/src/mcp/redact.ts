/**
 * The one filter for every string that leaves tunelo's MCP side (tool
 * results, errors, tool lists, `tunelo mcp` stderr, log lines): no token
 * this service sent, nothing shaped like a JWT, no `Bearer <value>`, even
 * when a server or a proxy in front of it echoes them back. A JWT the user
 * really wrote in a message is hidden too: the rule cannot tell them apart.
 *
 * Sign-in secrets the user gave (request_secret) are hidden too, in this
 * process, from the moment tunelo holds their value: as typed, and in the
 * simple forms a page or a command echoes them in (base64, base64url,
 * URL-encoded, JSON-escaped). redactDeep applies the same to every string of
 * a value (a tool's output, a transcript item).
 */

/** A JWT, whole or cut: base64url JSON (`eyJ` is `{"`) and up to two more segments. */
const JWT = /eyJ[\w-]{8,}(?:\.[\w-]*){0,2}/g;
const BEARER = /\b(Bearer)\s+[^\s"'\\,;]+/gi;
const HIDDEN = "[hidden]";

/** Error and log text is cut to this many characters. */
export const MAX_MESSAGE_CHARS = 500;

/** Shorter values are not hidden: they would cut ordinary words apart. */
export const MIN_SECRET_CHARS = 3;
/** Every form of every secret value this process holds, longest first. */
let secretForms: string[] = [];
const secretValues = new Set<string>();

/** The forms a secret value is hidden in. */
export function secretVariants(value: string): string[] {
	const bytes = Buffer.from(value, "utf8");
	const forms = new Set([
		value,
		bytes.toString("base64"),
		bytes.toString("base64").replace(/=+$/, ""),
		bytes.toString("base64url"),
		encodeURIComponent(value),
		encodeURIComponent(value).replace(/%20/g, "+"),
		JSON.stringify(value).slice(1, -1),
	]);
	return [...forms].filter((form) => form.length >= MIN_SECRET_CHARS);
}

/** From now on, `value` never leaves this process in clear (see the module comment). */
export function rememberSecret(value: string): void {
	if (value.length < MIN_SECRET_CHARS || secretValues.has(value)) return;
	secretValues.add(value);
	secretForms = [...new Set([...secretForms, ...secretVariants(value)])].sort((a, b) => b.length - a.length);
}

/** Forgets every secret value (tests). */
export function forgetSecrets(): void {
	secretValues.clear();
	secretForms = [];
}

function hideSecrets(text: string): string {
	let out = text;
	for (const form of secretForms) if (out.includes(form)) out = out.split(form).join(HIDDEN);
	return out;
}

/** `text` without the `known` tokens, secret values, JWTs or Bearer values. */
export function redact(text: string, known: Iterable<string> = []): string {
	let out = hideSecrets(text);
	for (const token of known) if (token) out = out.split(token).join(HIDDEN);
	return out.replace(JWT, HIDDEN).replace(BEARER, `$1 ${HIDDEN}`);
}

/** `text` without the secret values only (no JWT rule): for what the user and Claude read. */
export function redactSecrets(text: string): string {
	return secretForms.length === 0 ? text : hideSecrets(text);
}

/**
 * `value` with redactSecrets applied to every string in it (plain objects and
 * arrays are walked; bytes and other objects are kept as they are). The same
 * value when nothing had to change, so callers can tell.
 */
export function redactDeep<T>(value: T): T {
	if (secretForms.length === 0) return value;
	const walk = (node: unknown): unknown => {
		if (typeof node === "string") return hideSecrets(node);
		if (Array.isArray(node)) {
			const next = node.map(walk);
			return next.some((child, i) => child !== node[i]) ? next : node;
		}
		if (typeof node !== "object" || node === null || Object.getPrototypeOf(node) !== Object.prototype) return node;
		let changed = false;
		const out: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(node)) {
			const next = walk(child);
			if (next !== child) changed = true;
			out[key] = next;
		}
		return changed ? out : node;
	};
	return walk(value) as T;
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
