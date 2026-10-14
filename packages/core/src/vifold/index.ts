// Vietnamese search folding (ADR 0005). The normative algorithm and the shared
// test vectors live in spec/vi-fold; the Go twin is server/internal/vifold.

const NONSPACING_MARK = /\p{Mn}/gu;
const WHITE_SPACE_RUN = /\p{White_Space}+/gu;
const EDGE_SPACE = /^ | $/g;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

// Code points that UAX #29 keeps attached to the preceding character (WB4):
// Extend, Format and ZWJ. U+200B is Cf but is not Format, so it is excluded.
const ATTACHES_TO_PREVIOUS = /[\p{Grapheme_Extend}\p{Mc}\p{Emoji_Modifier}\p{Cf}]/u;
const ZERO_WIDTH_SPACE = "\u200B";

// Isolating classes (SPEC.md, tokenization tailoring). Katakana is
// Word_Break=Katakana from Unicode 15.0.
const KATAKANA =
	/[\u3031-\u3035\u309B\u309C\u30A0-\u30FA\u30FC-\u30FF\u31F0-\u31FF\u32D0-\u32FE\u3300-\u3357\uFF66-\uFF9D\u{1AFF0}-\u{1AFF3}\u{1AFF5}-\u{1AFFB}\u{1AFFD}\u{1AFFE}\u{1B000}\u{1B120}-\u{1B122}\u{1B155}\u{1B164}-\u{1B167}]/u;
const HANGUL = /\p{sc=Hangul}/u;
const SINGLE_CHARACTER =
	/(?!\p{Nd})[\p{sc=Han}\p{sc=Hiragana}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}\p{sc=Tai_Le}\p{sc=New_Tai_Lue}\p{sc=Tai_Tham}\p{sc=Tai_Viet}\p{sc=Ahom}]/u;

// Word_Break MidLetter, MidNum, MidNumLet, Single_Quote and Double_Quote
// (Unicode 15.0): joiners whose UAX #29 rules look at both neighbours.
const MIDDLE =
	/[\u0022\u0027\u002C\u002E\u003A\u003B\u00B7\u037E\u0387\u055F\u0589\u05F4\u060C\u060D\u066C\u07F8\u2018\u2019\u2024\u2027\u2044\uFE10\uFE13\uFE14\uFE50\uFE52\uFE54\uFE55\uFF07\uFF0C\uFF0E\uFF1A\uFF1B]/u;

type IsolatingClass = "katakana" | "hangul" | "single";

/** A code point that does not attach to its predecessor under WB4. */
interface Base {
	readonly position: number;
	readonly isolating: IsolatingClass | undefined;
	readonly middle: boolean;
}

function isolatingClass(char: string): IsolatingClass | undefined {
	if (KATAKANA.test(char)) return "katakana";
	if (HANGUL.test(char)) return "hangul";
	if (SINGLE_CHARACTER.test(char)) return "single";
	return undefined;
}

// A fixed locale keeps segmentation identical on every device; ICU has no
// word-break tailoring that matters here.
const wordSegmenter = new Intl.Segmenter("en", { granularity: "word" });

/** Folds text for search: case, diacritics, `đ`, final sigma and whitespace. */
export function fold(text: string): string {
	const lowered = text.normalize("NFC").toLowerCase();
	const stripped = lowered
		.normalize("NFD")
		.replace(NONSPACING_MARK, "")
		.replaceAll("\u0111", "d") // đ
		.replaceAll("\u03C2", "\u03C3"); // final sigma ς to σ
	return stripped.normalize("NFC").replace(WHITE_SPACE_RUN, " ").replace(EDGE_SPACE, "");
}

/** Returns the search tokens of the folded text (UAX #29 words with a letter or digit). */
export function tokens(text: string): string[] {
	return segmentWords(fold(text)).filter((segment) => LETTER_OR_NUMBER.test(segment));
}

/**
 * The text a search engine indexes and queries: the tokens joined by single
 * spaces. Engines re-tokenize what they receive, so both the indexed column
 * and every query must use this rather than `fold`.
 */
export function searchText(text: string): string {
	return tokens(text).join(" ");
}

/**
 * SQLite FTS5 tokenizer arguments under which the FTS5 tokens of
 * `searchText(x)` equal `tokens(x)` (SPEC.md section 4.1). Every category except
 * Z* is a token character, so only spaces separate; U+180E is added because
 * SQLite's tables still class it as a space separator (Zs) while Unicode,
 * and therefore `fold`, treat it as a format character.
 */
export const FTS5_TOKENIZE = "unicode61 remove_diacritics 0 categories 'L* N* M* P* S* C*' tokenchars '᠎'";

function attachesToPrevious(char: string): boolean {
	return char !== ZERO_WIDTH_SPACE && ATTACHES_TO_PREVIOUS.test(char);
}

function basesOf(text: string): Base[] {
	const bases: Base[] = [];
	let position = 0;
	for (const char of text) {
		if (bases.length === 0 || !attachesToPrevious(char)) {
			bases.push({ position, isolating: isolatingClass(char), middle: MIDDLE.test(char) });
		}
		position += char.length;
	}
	return bases;
}

/**
 * Splits text at UAX #29 word boundaries with the isolating-class tailoring
 * of SPEC.md. Intl.Segmenter supplies the default boundaries; wherever an
 * isolating class is involved the tailoring decides alone, which also
 * discards ICU's dictionary breaks (CJK, Thai, ...) and its deviations around
 * Hangul and complex-context scripts.
 */
function segmentWords(text: string): string[] {
	const isBoundary = new Array<boolean>(text.length + 1).fill(false);
	isBoundary[text.length] = true;
	for (const { index } of wordSegmenter.segment(text)) {
		isBoundary[index] = true;
	}

	const bases = basesOf(text);
	for (let i = 1; i < bases.length; i++) {
		const previous = bases[i - 1];
		const current = bases[i];
		if (previous === undefined || current === undefined) continue;
		if (previous.isolating !== undefined || current.isolating !== undefined) {
			const joins = previous.isolating === current.isolating && current.isolating !== "single";
			isBoundary[current.position] = !joins;
		}
		// An isolating neighbour on either side cannot take part in the
		// letter/number rules (WB6, WB7, WB11, WB12), so the joiner stands alone.
		const next = bases[i + 1];
		if (current.middle && (previous.isolating !== undefined || next?.isolating !== undefined)) {
			isBoundary[current.position] = true;
			if (next !== undefined) isBoundary[next.position] = true;
		}
	}

	const segments: string[] = [];
	let start = 0;
	for (let end = 1; end <= text.length; end++) {
		if (isBoundary[end]) {
			segments.push(text.slice(start, end));
			start = end;
		}
	}
	return segments;
}
