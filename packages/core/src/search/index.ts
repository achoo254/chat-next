// Local search (ADR 0005): the query is folded by the same vifold rules as
// the indexed text, so "tieng viet" finds "Tiếng Việt". Every token must
// match; the last one also matches as a prefix so results follow typing.
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

export interface SearchOptions {
	/** Restricts the search to one chat; 0 searches every chat. */
	readonly chatId?: number;
	readonly limit?: number;
}

/**
 * Searches cached messages, newest first. Stale hits (cache older than a
 * too_long) are returned flagged so the UI can revalidate them.
 */
export async function searchLocal(
	repo: Repository,
	query: string,
	options: SearchOptions = {},
): Promise<StoredMessage[]> {
	const match = ftsQuery(query);
	if (match === null) return [];
	return repo.search(match, options.chatId ?? 0, Math.max(1, Math.min(options.limit ?? 50, 500)));
}
