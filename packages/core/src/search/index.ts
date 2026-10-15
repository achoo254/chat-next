// Local search (ADR 0005): the query is folded by the same vifold rules as
// the indexed text, so "tieng viet" finds "Tiếng Việt". Matching follows the
// server (server/internal/search): every token must appear inside the search
// text ("uan" finds "tuần"), through the trigram FTS5 table. When every token
// is shorter than SUBSTRING_MIN_CHARS, a substring would match almost every
// message and has no whole trigram, so the tokens must be words instead (the
// unicode61 FTS5 table), the last one also as a prefix so results follow
// typing.
import type { SearchFilters } from "../model/types.ts";
import type { Repository, StoredMessage } from "../repo/repository.ts";
import { searchText } from "../vifold/index.ts";

/** The shortest token matched as a substring (a trigram); the server's search.SubstringMinRunes. */
export const SUBSTRING_MIN_CHARS = 3;

/** Length in code points, as FTS5 trigrams and Go runes count. */
function charCount(token: string): number {
	return [...token].length;
}

/** Whether these query tokens match as substrings rather than word starts. */
export function matchesSubstrings(tokens: readonly string[]): boolean {
	return tokens.some((token) => charCount(token) >= SUBSTRING_MIN_CHARS);
}

/** How the tokens of a query are matched against the cached search text. */
export type TextMatch =
	/**
	 * Every token inside the search text: `trigram` is the MATCH expression of
	 * the long tokens for the trigram table, `contains` the short tokens,
	 * checked on the rows it finds.
	 */
	| { readonly kind: "substring"; readonly trigram: string; readonly contains: readonly string[] }
	/** Every token is a word, the last one a prefix: `fts` is the MATCH expression for the unicode61 table. */
	| { readonly kind: "words"; readonly fts: string };

/** Quotes a token as an FTS5 string, so user input cannot inject FTS5 syntax. */
function quote(token: string): string {
	return `"${token.replaceAll('"', '""')}"`;
}

/** The words rule as an FTS5 MATCH expression: every token a word, the last also a prefix. */
function wordsExpression(tokens: readonly string[]): string {
	const parts = tokens.map(quote);
	const last = parts.length - 1;
	parts[last] = `${parts[last] ?? ""}*`;
	return parts.join(" ");
}

/** FTS5 MATCH expression of the words rule for a user query; null when nothing is searchable. */
export function ftsQuery(query: string): string | null {
	const folded = searchText(query);
	return folded === "" ? null : wordsExpression(folded.split(" "));
}

/** How a user query matches cached messages; null when nothing is searchable. */
export function textMatch(query: string): TextMatch | null {
	const folded = searchText(query);
	if (folded === "") return null;
	const tokens = folded.split(" ");
	if (!matchesSubstrings(tokens)) return { kind: "words", fts: wordsExpression(tokens) };
	return {
		kind: "substring",
		trigram: tokens
			.filter((token) => charCount(token) >= SUBSTRING_MIN_CHARS)
			.map(quote)
			.join(" "),
		contains: tokens.filter((token) => charCount(token) < SUBSTRING_MIN_CHARS),
	};
}

/** Whether any filter is set: a search with filters needs no words. */
export function hasFilters(filters: SearchFilters | undefined): boolean {
	if (filters === undefined) return false;
	return (
		(filters.fromId ?? 0) !== 0 ||
		filters.mediaKind !== undefined ||
		filters.hasLink === true ||
		(filters.since ?? 0) > 0 ||
		(filters.until ?? 0) > 0
	);
}

export interface SearchOptions {
	/** Restricts the search to one chat; 0 searches every chat. */
	readonly chatId?: number;
	/** With chatId, restricts it to one forum topic; 0 = every topic. */
	readonly topicId?: number;
	readonly filters?: SearchFilters;
	readonly limit?: number;
}

/**
 * Searches cached messages, newest first. Stale hits (cache older than a
 * too_long) are returned flagged so the UI can revalidate them.
 */
export async function searchLocal(repo: Repository, query: string, options: SearchOptions = {}): Promise<StoredMessage[]> {
	const match = textMatch(query);
	const filters = options.filters ?? {};
	if (match === null && !hasFilters(filters)) return [];
	return repo.search({
		match,
		chatId: options.chatId ?? 0,
		topicId: options.chatId === undefined || options.chatId === 0 ? 0 : (options.topicId ?? 0),
		filters,
		limit: Math.max(1, Math.min(options.limit ?? 50, 500)),
	});
}
