// Merging the local search (instant, this device's cache) with the server's
// (complete, arrives later). Rows already on screen keep their place: hits
// the server adds go after the local ones, so the list never jumps under the
// user's pointer. The server is the authority on stale cache: a stale local
// hit it returns is verified, one it does not return once it has answered
// in full is dropped.
import type { StoredMessage } from "../repo/repository.ts";

export type HitSource = "local" | "server" | "both";

export interface SearchHit {
	/** The server's copy when the server returned it (fresher), else the cached one. */
	readonly message: StoredMessage;
	readonly source: HitSource;
}

export interface ServerHits {
	/** Every hit of the pages fetched so far, in server order. */
	readonly messages: readonly StoredMessage[];
	/** The server returned its last page: anything it did not return is not a hit. */
	readonly complete: boolean;
}

export function hitKey(message: { readonly chatId: number; readonly seq: number }): string {
	return `${message.chatId}:${message.seq}`;
}

export function mergeSearchHits(local: readonly StoredMessage[], server: ServerHits | null): SearchHit[] {
	const out: SearchHit[] = [];
	const seen = new Set<string>();
	const fromServer = new Map<string, StoredMessage>();
	for (const message of server?.messages ?? []) fromServer.set(hitKey(message), message);
	for (const message of local) {
		const key = hitKey(message);
		if (seen.has(key)) continue;
		const verified = fromServer.get(key);
		if (verified !== undefined) {
			out.push({ message: verified, source: "both" });
		} else if (message.stale && server?.complete === true) {
			// The cache is behind and the server no longer counts it as a hit
			// (edited, deleted or out of the user's reach).
			continue;
		} else {
			out.push({ message, source: "local" });
		}
		seen.add(key);
	}
	for (const message of server?.messages ?? []) {
		const key = hitKey(message);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ message, source: "server" });
	}
	return out;
}

/** Newest first by seq within one chat, the order of in-chat navigation. */
export function sortNewestFirst(hits: readonly SearchHit[]): SearchHit[] {
	return [...hits].sort((a, b) => b.message.date - a.message.date || b.message.chatId - a.message.chatId || b.message.seq - a.message.seq);
}
