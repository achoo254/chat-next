// Local search (ADR 0005): the query is folded by the same vifold rules as
// the indexed text, so "tieng viet" finds "Tiếng Việt". Every token must
// match; the last one also matches as a prefix so results follow typing.
import type { SearchFilters } from "../model/types.ts";
import type { Repository, StoredMessage } from "../repo/repository.ts";
import { searchText } from "../vifold/index.ts";

function quote(token: string): string {
	return `"${token.replaceAll('"', '""')}"`;
}

/** FTS5 MATCH expression for a user query; null when nothing is searchable. */
export function ftsQuery(query: string): string | null {
	const folded = searchText(query);
	if (folded === "") return null;
	const parts = folded.split(" ").map(quote);
	const last = parts.length - 1;
	parts[last] = `${parts[last] ?? ""}*`;
	return parts.join(" ");
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
	const match = ftsQuery(query);
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
