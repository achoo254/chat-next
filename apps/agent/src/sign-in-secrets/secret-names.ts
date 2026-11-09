/**
 * What a sign-in secret is called and where it may be used: a name Claude
 * picks (it becomes `$TUNELO_SECRET_<NAME>` in commands), the site it belongs
 * to (scheme, host and port only), and the reference Claude gets instead of
 * the value.
 */

/** Upper-case letters, digits and "_", starting with a letter: it is part of an environment variable. */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,47}$/;
export const ENV_PREFIX = "TUNELO_SECRET_";
/** `$TUNELO_SECRET_X` or `${TUNELO_SECRET_X}` in a command. */
const ENV_REFERENCE = /\$\{?TUNELO_SECRET_([A-Z][A-Z0-9_]{0,47})\b/g;
const REF_PREFIX = "secret://";
const REF = /^secret:\/\/([A-Za-z0-9_-]{8,64})$/;
export const MAX_SECRET_CHARS = 4096;
export const MAX_PURPOSE_CHARS = 300;

export class SecretInputError extends Error {}

/**
 * The origin of a site the user typed or Claude named: `https://host[:port]`
 * (http only for loopback). Paths, queries and fragments are dropped; user
 * names and passwords in the URL are refused.
 */
export function normalizeOrigin(input: string): string {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		throw new SecretInputError(`${input.slice(0, 200)} is not a URL: give the site as https://host`);
	}
	if (url.username || url.password) throw new SecretInputError("the site may not carry a user name or password");
	const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
		throw new SecretInputError("the site must be https:// (http:// only for localhost)");
	}
	return url.origin;
}

/** The origin of a page URL; undefined for pages that have none (about:blank, data:, chrome://). */
export function originOf(pageUrl: string): string | undefined {
	try {
		const origin = new URL(pageUrl).origin;
		return origin === "null" ? undefined : origin;
	} catch {
		return undefined;
	}
}

export function checkName(name: string): string {
	if (!SECRET_NAME.test(name)) throw new SecretInputError("the name must be upper-case letters, digits or _, starting with a letter (at most 48)");
	return name;
}

/** A value the user typed: not empty, not too long, no control characters. */
export function checkValue(value: string): string {
	// eslint-disable-next-line no-control-regex
	if (value.length === 0 || value.length > MAX_SECRET_CHARS || /[\u0000-\u001f\u007f]/.test(value)) {
		throw new SecretInputError("the value is empty, too long or has control characters");
	}
	return value;
}

export function envName(name: string): string {
	return `${ENV_PREFIX}${name}`;
}

/** The secret names a command reads from its environment, in order, once each. */
export function envNamesIn(command: string): string[] {
	return [...new Set([...command.matchAll(ENV_REFERENCE)].map((m) => m[1] ?? "").filter(Boolean))];
}

export function refOf(id: string): string {
	return `${REF_PREFIX}${id}`;
}

/** The id inside a reference; undefined when it is no reference of tunelo's. */
export function idOfRef(ref: string): string | undefined {
	return REF.exec(ref.trim())?.[1];
}
