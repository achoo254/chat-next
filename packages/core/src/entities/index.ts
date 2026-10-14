// Text model (ADR 0004): a message is `text` plus `entities[]` whose offset
// and length count UTF-16 code units; length limits count code points.
// The Go twin is server/internal/entities; spec/entities/test-vectors.json is
// shared by both test suites.

/** Position of an entity inside a message text, in UTF-16 code units. */
export interface EntitySpan {
	readonly offset: number;
	readonly length: number;
}

export type EntityErrorCode =
	| "invalid_offset"
	| "invalid_length"
	| "out_of_bounds"
	| "splits_surrogate_pair"
	| "partial_overlap";

export interface EntityError {
	/** Index of the offending entity in the input array. */
	readonly index: number;
	readonly code: EntityErrorCode;
}

/** Length of `text` in UTF-16 code units (the entity offset unit). */
export function utf16Length(text: string): number {
	return text.length;
}

/** Number of Unicode code points in `text` (the unit of length limits). */
export function codePointLength(text: string): number {
	let count = 0;
	for (const _ of text) {
		count++;
	}
	return count;
}

function isHighSurrogate(unit: number): boolean {
	return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
	return unit >= 0xdc00 && unit <= 0xdfff;
}

/** True when `position` falls between the two halves of a surrogate pair. */
function splitsSurrogatePair(text: string, position: number): boolean {
	return (
		position > 0 &&
		position < text.length &&
		isHighSurrogate(text.charCodeAt(position - 1)) &&
		isLowSurrogate(text.charCodeAt(position))
	);
}

function spanError(text: string, span: EntitySpan): EntityErrorCode | undefined {
	if (!Number.isSafeInteger(span.offset) || span.offset < 0) {
		return "invalid_offset";
	}
	if (!Number.isSafeInteger(span.length) || span.length <= 0) {
		return "invalid_length";
	}
	const end = span.offset + span.length;
	if (end > text.length) {
		return "out_of_bounds";
	}
	if (splitsSurrogatePair(text, span.offset) || splitsSurrogatePair(text, end)) {
		return "splits_surrogate_pair";
	}
	return undefined;
}

/**
 * Validates entity spans against `text`. Each entity gets at most one error;
 * errors are ordered by entity index. Entities may nest (including identical
 * spans) but must not partially overlap: after sorting by (offset ascending,
 * end descending, index ascending), the later entity of an overlapping pair
 * gets `partial_overlap`. Runs in O(n log n).
 */
export function validateEntities(text: string, entities: readonly EntitySpan[]): EntityError[] {
	const errors: EntityError[] = [];
	const valid: { index: number; offset: number; end: number }[] = [];

	entities.forEach((span, index) => {
		const code = spanError(text, span);
		if (code === undefined) {
			valid.push({ index, offset: span.offset, end: span.offset + span.length });
		} else {
			errors.push({ index, code });
		}
	});

	valid.sort((a, b) => a.offset - b.offset || b.end - a.end || a.index - b.index);
	// Ends of the currently open (enclosing) entities, innermost last.
	const openEnds: number[] = [];
	for (const span of valid) {
		let enclosingEnd = openEnds.at(-1);
		while (enclosingEnd !== undefined && enclosingEnd <= span.offset) {
			openEnds.pop();
			enclosingEnd = openEnds.at(-1);
		}
		if (enclosingEnd !== undefined && span.end > enclosingEnd) {
			errors.push({ index: span.index, code: "partial_overlap" });
		} else {
			openEnds.push(span.end);
		}
	}

	return errors.sort((a, b) => a.index - b.index);
}

// RFC 3986 scheme followed by ':'.
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;
const SCHEME_NAME = /^[A-Za-z][A-Za-z0-9+.-]*$/;
// Control characters, format characters (zero-width, bidi overrides),
// whitespace and lone surrogates anywhere in a URL are rejected: browsers strip
// some of them, so "java\tscript:" or " javascript:" would otherwise run as
// javascript:.
const FORBIDDEN_CHARACTER = /[\p{Cc}\p{Cf}\p{Cs}\p{White_Space}]/u;
// http(s) must carry a non-empty authority.
const WEB_AUTHORITY = /^\/\/[^/?#]/;
const AUTHORITY_END = /[/?#]/;
// Userinfo ("https://google.com@evil.com") shows one host and opens another,
// so any '@' in the authority, literal or percent-encoded, is rejected. The
// authority ends only at '/', '?' or '#' (not backslash), so a parser that does
// not treat backslash as a separator cannot see userinfo the check missed.
const USERINFO_MARK = /@|%40/i;
// In scheme-less link text, "host:port" (localhost:3000, example.com:8080/x)
// also matches SCHEME; a port of 1 to 5 digits ending the text or followed by
// '/', '?' or '#' marks it as a host instead.
const PORT = /^[0-9]{1,5}(?:[/?#]|$)/;
const EDGE_WHITE_SPACE = /^\p{White_Space}+|\p{White_Space}+$/gu;

// App routes under this segment belong to the sign-in flow (ADR 0006).
const AUTH_SEGMENT = "auth";
const ROUTE_END = /[?#]/;
const PERCENT_ESCAPE = /%([0-9A-Fa-f]{2})/g;
const MALFORMED_ESCAPE = /%(?![0-9A-Fa-f]{2})/;
const SEGMENT_SEPARATOR = /[/\\]/;
const SEGMENT_NAME_END = /[:;]/;

interface ParsedUrl {
	/** Lower-cased scheme. */
	readonly scheme: string;
	/** Everything after "scheme:". */
	readonly rest: string;
}

function parseUrl(url: string): ParsedUrl | undefined {
	if (FORBIDDEN_CHARACTER.test(url)) {
		return undefined;
	}
	const match = SCHEME.exec(url);
	const scheme = match?.[1]?.toLowerCase();
	if (match === null || scheme === undefined) {
		return undefined;
	}
	return { scheme, rest: url.slice(match[0].length) };
}

function isWebUrl({ scheme, rest }: ParsedUrl): boolean {
	if ((scheme !== "http" && scheme !== "https") || !WEB_AUTHORITY.test(rest)) {
		return false;
	}
	const afterSlashes = rest.slice(2);
	const end = afterSlashes.search(AUTHORITY_END);
	const authority = end === -1 ? afterSlashes : afterSlashes.slice(0, end);
	return !USERINFO_MARK.test(authority);
}

/**
 * Reports whether an app-scheme link reaches the sign-in callback area
 * (`com.hoandat.chat:/auth/callback`), which only the system browser may open.
 * Deep-link routers differ in how they read the authority, letter case and
 * escapes, so this covers every reading: the part before '?' or '#' is
 * percent-decoded, split at '/' and backslash, and any segment whose name (without
 * userinfo before '@' or anything from ':' or ';') is "auth" in any ASCII case
 * matches. A malformed escape also matches.
 */
function targetsAuthRoute(rest: string): boolean {
	const end = rest.search(ROUTE_END);
	const route = end === -1 ? rest : rest.slice(0, end);
	if (MALFORMED_ESCAPE.test(route)) {
		return true;
	}
	const decoded = route.replace(PERCENT_ESCAPE, (_escape, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
	return decoded.split(SEGMENT_SEPARATOR).some((segment) => {
		const host = segment.slice(segment.lastIndexOf("@") + 1);
		const nameEnd = host.search(SEGMENT_NAME_END);
		const name = nameEnd === -1 ? host : host.slice(0, nameEnd);
		return name.toLowerCase() === AUTH_SEGMENT;
	});
}

/**
 * Allows only `http:`, `https:`, `mailto:` and the app's own scheme
 * (case-insensitive). Relative and scheme-relative URLs are rejected, as are
 * http(s) URLs with userinfo (`https://google.com@evil.com`) and app-scheme
 * links into the sign-in callback routes (`/auth/...`).
 */
export function isAllowedUrl(url: string, appScheme: string): boolean {
	const parsed = parseUrl(url);
	if (parsed === undefined) {
		return false;
	}
	const { scheme, rest } = parsed;
	switch (scheme) {
		case "http":
		case "https":
			return isWebUrl(parsed);
		case "mailto":
			return rest.length > 0;
		default:
			return (
				SCHEME_NAME.test(appScheme) &&
				scheme === appScheme.toLowerCase() &&
				rest.length > 0 &&
				!targetsAuthRoute(rest)
			);
	}
}

/**
 * Allows only absolute `http:` and `https:` URLs without userinfo. Use it for URLs that are
 * fetched or embedded rather than opened by the user: thumbnail_url,
 * mini_app_url and webhook targets.
 */
export function isAllowedWebUrl(url: string): boolean {
	const parsed = parseUrl(url);
	return parsed !== undefined && isWebUrl(parsed);
}

function hasScheme(text: string): boolean {
	const match = SCHEME.exec(text);
	return match !== null && !PORT.test(text.slice(match[0].length));
}

/**
 * Turns the visible text of a `url` entity into the URL it opens: trims
 * Unicode White_Space, prefixes `https://` when the text has no scheme
 * (`example.com`, `localhost:3000`), then applies {@link isAllowedUrl}.
 * Returns undefined when the result is not allowed.
 */
export function normalizeLinkUrl(text: string, appScheme: string): string | undefined {
	const trimmed = text.replace(EDGE_WHITE_SPACE, "");
	if (trimmed === "") {
		return undefined;
	}
	const url = hasScheme(trimmed) ? trimmed : `https://${trimmed}`;
	return isAllowedUrl(url, appScheme) ? url : undefined;
}
