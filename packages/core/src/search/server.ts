// Message search on the server (SearchService, R4): the whole history the
// user can see, not only what this device has cached. Hits are not written
// into the cached history (they are sparse, and the history cache assumes
// contiguous ranges); their senders are, so names resolve.
import type { Chat, SearchFilters, User } from "../model/types.ts";
import type { RemoteApi } from "../protocol/api.ts";
import { toChat, toMessage, toUser, toWireId, toWireMediaKind } from "../protocol/map.ts";
import type { StoredMessage } from "../repo/repository.ts";

/** Server page size used when the caller sets none; the server allows 1 to 50. */
export const SERVER_PAGE = 20;

export interface ServerSearchRequest {
	readonly query: string;
	/** 0 or absent: every chat of the user (exact-accent matches first); else that chat, newest first. */
	readonly chatId?: number;
	/** With chatId, one forum topic; 0 = every topic. */
	readonly topicId?: number;
	readonly filters?: SearchFilters;
	/** NextCursor of the previous page; "" or absent for the first. */
	readonly cursor?: string;
	readonly limit?: number;
}

export interface ServerSearchPage {
	readonly messages: readonly StoredMessage[];
	readonly chats: readonly Chat[];
	readonly users: readonly User[];
	/** "" when there are no more pages. */
	readonly nextCursor: string;
}

type SearchApi = NonNullable<RemoteApi["search"]>;

function wireFilter(filters: SearchFilters | undefined) {
	const f = filters ?? {};
	return {
		fromId: toWireId(f.fromId ?? 0),
		mediaKind: f.mediaKind === undefined ? 0 : toWireMediaKind(f.mediaKind),
		minDate: BigInt(Math.max(0, Math.floor(f.since ?? 0))),
		maxDate: BigInt(Math.max(0, Math.floor(f.until ?? 0))),
		hasLink: f.hasLink === true,
	};
}

/** Asks the server for one page of hits. */
export async function fetchServerSearch(api: SearchApi, request: ServerSearchRequest): Promise<ServerSearchPage> {
	const limit = Math.max(1, Math.min(request.limit ?? SERVER_PAGE, 50));
	const filter = wireFilter(request.filters);
	const chatId = request.chatId ?? 0;
	const response =
		chatId === 0
			? await api.searchMessages({ query: request.query, filter, cursor: request.cursor ?? "", limit })
			: await api.searchChatMessages({
					chatId: toWireId(chatId),
					topicId: toWireId(request.topicId ?? 0),
					query: request.query,
					filter,
					cursor: request.cursor ?? "",
					limit,
				});
	return {
		messages: response.messages.map((message) => ({ ...toMessage(message), stale: false })),
		chats: response.chats.map(toChat),
		users: response.users.map(toUser),
		nextCursor: response.nextCursor,
	};
}
