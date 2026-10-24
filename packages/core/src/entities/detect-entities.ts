// Links, e-mail addresses, @mentions and #hashtags found in plain text, as
// the server adds them to every message it stores (Go twin: Detect in
// server/internal/entities/detect.go; both run the shared vectors in
// spec/entities/detect-vectors.json). Clients use it to show the same
// entities on messages stored before the server detected them.
import { normalizeLinkUrl } from "./index.ts";
import { KNOWN_TLDS } from "./known-tlds.ts";

export type DetectedEntityType = "url" | "email" | "mention" | "hashtag";

export interface DetectedEntity {
	readonly type: DetectedEntityType;
	/** UTF-16 code units (ADR 0004). */
	readonly offset: number;
	readonly length: number;
}

/** An entity the text already has; only its type and span matter here. */
export interface ExistingEntity {
	readonly type: string;
	readonly offset: number;
	readonly length: number;
}

/** Style entities a detected entity may sit inside; every other entity keeps its text out of detection. */
const CONTAINER_TYPES: ReadonlySet<string> = new Set(["bold", "italic", "underline", "strike", "spoiler"]);

/** Characters that join a candidate to the word before it. */
const START_EXCLUDED = "@.-/\\#$%&+=~";
/** May sit between a candidate and the "…" of a cut text. */
const CUT_PUNCTUATION = ".,;:!?)]}-";
const WORD = /^[\p{L}\p{Nd}\p{M}_]$/u;
const LETTER = /^\p{L}$/u;
const URL_STOP = /^[\p{Cc}\p{Cf}\p{White_Space}<>"'`…]$/u;
const ASCII_ALNUM = /^[A-Za-z0-9]$/;
const DIGIT = /^[0-9]$/;
const EMAIL_LOCAL = /^[A-Za-z0-9._%+-]$/;
const HOST_CHAR = /^[A-Za-z0-9.-]$/;
const HOST_MAX = 253;
const LABEL_MAX = 63;
/** Usernames have 3 to 32 characters (server/internal/profile). */
const MENTION_MIN = 3;
const MENTION_MAX = 32;

const isWord = (c: string | undefined): boolean => c !== undefined && WORD.test(c);
const isUrlStop = (c: string): boolean => URL_STOP.test(c);
const isAsciiAlnum = (c: string | undefined): boolean => c !== undefined && ASCII_ALNUM.test(c);

/**
 * The url, email, mention and hashtag entities of `text` outside `existing`
 * (or inside its bold, italic, underline, strike or spoiler entities), at
 * most `limit`, in text order. The rules are documented on Detect in
 * server/internal/entities/detect.go.
 */
export function detectEntities(
	text: string,
	existing: readonly ExistingEntity[],
	appScheme: string,
	limit: number,
): DetectedEntity[] {
	const found: DetectedEntity[] = [];
	if (limit <= 0 || text === "") return found;
	const chars = Array.from(text);
	const pos: number[] = [0];
	for (const c of chars) pos.push((pos[pos.length - 1] ?? 0) + c.length);
	const n = chars.length;
	const at = (i: number): string => chars[i] ?? "";
	const slice = (start: number, end: number): string => chars.slice(start, end).join("");

	const followedByWord = (end: number): boolean => end < n && (isWord(at(end)) || at(end) === "@");

	const add = (type: DetectedEntityType, start: number, end: number): void => {
		let k = end;
		while (k < n && CUT_PUNCTUATION.includes(at(k))) k++;
		if (at(k) === "…") return;
		const offset = pos[start] ?? 0;
		const stop = pos[end] ?? 0;
		for (const entity of existing) {
			const entityEnd = entity.offset + entity.length;
			const disjoint = stop <= entity.offset || offset >= entityEnd;
			const inside = CONTAINER_TYPES.has(entity.type) && entity.offset <= offset && stop <= entityEnd;
			if (!disjoint && !inside) return;
		}
		found.push({ type, offset, length: stop - offset });
	};

	// [end, next]: next 0 when there is no http(s) prefix at i; end 0 when the link is not allowed.
	const schemeUrl = (i: number): [number, number] => {
		let j = i;
		for (const prefix of ["https://", "http://"]) {
			if (i + prefix.length <= n && asciiLower(slice(i, i + prefix.length)) === prefix) {
				j = i + prefix.length;
				break;
			}
		}
		if (j === i) return [0, 0];
		let stop = j;
		while (stop < n && !isUrlStop(at(stop))) stop++;
		const end = trimLinkEnd(chars, i, stop);
		if (end <= j || normalizeLinkUrl(slice(i, end), appScheme) === undefined) return [0, stop];
		return [end, stop];
	};

	const host = (i: number): number => {
		let j = i;
		while (j < n && HOST_CHAR.test(at(j))) j++;
		while (j > i && (at(j - 1) === "." || at(j - 1) === "-")) j--;
		if (j - i > HOST_MAX) return 0;
		const labels = slice(i, j).split(".");
		if (labels.length < 2) return 0;
		for (const label of labels) {
			if (label === "" || label.length > LABEL_MAX || label.startsWith("-") || label.endsWith("-")) return 0;
		}
		return KNOWN_TLDS.has(asciiLower(labels[labels.length - 1] ?? "")) ? j : 0;
	};

	const domain = (i: number): number => {
		let j = host(i);
		if (j === 0) return 0;
		if (at(j) === ":") {
			let k = j + 1;
			while (k < n && DIGIT.test(at(k))) k++;
			const digits = k - j - 1;
			if (digits >= 1 && digits <= 5 && !followedByWord(k)) j = k;
		}
		let end = j;
		if (j < n && "/?#".includes(at(j))) {
			let stop = j;
			while (stop < n && !isUrlStop(at(stop))) stop++;
			end = Math.max(trimLinkEnd(chars, i, stop), j);
		}
		if (followedByWord(end) || normalizeLinkUrl(slice(i, end), appScheme) === undefined) return 0;
		return end;
	};

	const email = (i: number): number => {
		let j = i;
		while (j < n && EMAIL_LOCAL.test(at(j))) j++;
		if (j === i || j >= n || at(j) !== "@" || at(i) === "." || at(j - 1) === ".") return 0;
		const end = host(j + 1);
		return end === 0 || followedByWord(end) ? 0 : end;
	};

	const mention = (i: number): number => {
		let j = i + 1;
		while (j < n && (isAsciiAlnum(at(j)) || at(j) === "_")) j++;
		const length = j - i - 1;
		return length < MENTION_MIN || length > MENTION_MAX || followedByWord(j) ? 0 : j;
	};

	const hashtag = (i: number): number => {
		let j = i + 1;
		let letter = false;
		while (j < n && isWord(at(j))) {
			letter ||= LETTER.test(at(j));
			j++;
		}
		return letter ? j : 0;
	};

	// [type, end, next]: next <= i means "try the next character".
	const match = (i: number): [DetectedEntityType | null, number, number] => {
		const c = at(i);
		if (!isAsciiAlnum(c) && c !== "@" && c !== "#") return [null, 0, 0];
		const prev = i > 0 ? at(i - 1) : "";
		if (i > 0 && isWord(prev)) return [null, 0, 0];
		const [urlEnd, urlNext] = schemeUrl(i);
		if (urlNext > 0) return urlEnd > 0 ? ["url", urlEnd, urlEnd] : [null, 0, urlNext];
		if (i > 0 && START_EXCLUDED.includes(prev)) return [null, 0, 0];
		if (c === "@") {
			const end = mention(i);
			return end > 0 ? ["mention", end, end] : [null, 0, 0];
		}
		if (c === "#") {
			const end = hashtag(i);
			return end > 0 ? ["hashtag", end, end] : [null, 0, 0];
		}
		const emailEnd = email(i);
		if (emailEnd > 0) return ["email", emailEnd, emailEnd];
		const domainEnd = domain(i);
		return domainEnd > 0 ? ["url", domainEnd, domainEnd] : [null, 0, 0];
	};

	for (let i = 0; i < n && found.length < limit; ) {
		const [type, end, next] = match(i);
		if (next <= i) {
			i++;
			continue;
		}
		if (type !== null) add(type, i, end);
		i = next;
	}
	return found;
}

/**
 * Drops trailing punctuation from the link chars[start:end]: . , ; : ! ?
 * always, and a closing bracket without an opening one left in the link.
 */
function trimLinkEnd(chars: readonly string[], start: number, end: number): number {
	const opens = "([{";
	const closes = ")]}";
	const open = [0, 0, 0];
	const closed = [0, 0, 0];
	for (let i = start; i < end; i++) {
		const c = chars[i] ?? "";
		const o = opens.indexOf(c);
		const k = closes.indexOf(c);
		if (o >= 0 && c !== "") open[o] = (open[o] ?? 0) + 1;
		else if (k >= 0 && c !== "") closed[k] = (closed[k] ?? 0) + 1;
	}
	while (end > start) {
		const c = chars[end - 1] ?? "";
		if (c !== "" && ".,;:!?".includes(c)) {
			end--;
			continue;
		}
		const k = c === "" ? -1 : closes.indexOf(c);
		if (k >= 0 && (closed[k] ?? 0) > (open[k] ?? 0)) {
			closed[k] = (closed[k] ?? 0) - 1;
			end--;
			continue;
		}
		break;
	}
	return end;
}

/** Lower-cases ASCII letters only, like the Go twin. */
function asciiLower(text: string): string {
	return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
}
