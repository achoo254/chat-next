// One search as the user types (phase 7, mockups/search.html#global): the
// local search runs at once on every change, the server is asked once the
// user pauses (debounced) and its pages are merged in (merge.ts). Answers to
// an older query are dropped. Offline, or when the server fails, the local
// hits stay and the state says why the server part is missing.
import type { FailureKind } from "../protocol/api.ts";
import type { SearchFilters } from "../model/types.ts";
import type { StoredMessage } from "../repo/repository.ts";
import { hasFilters, type SearchOptions } from "./index.ts";
import { mergeSearchHits, sortNewestFirst, type SearchHit } from "./merge.ts";
import { SERVER_PAGE, type ServerSearchPage, type ServerSearchRequest } from "./server.ts";
import { searchText } from "../vifold/index.ts";

export interface SearchRequest {
	readonly text: string;
	/** 0: every chat (global search); else in-chat search, newest first. */
	readonly chatId: number;
	readonly topicId: number;
	readonly filters: SearchFilters;
}

export type ServerSearchResult =
	| { readonly ok: true; readonly page: ServerSearchPage }
	| { readonly ok: false; readonly failure: FailureKind };

/**
 * The server part: idle (nothing to search), waiting (debounce), loading,
 * done, offline (not asked: no network) or failed (asked, no answer).
 */
export type ServerSearchStatus = "idle" | "waiting" | "loading" | "done" | "offline" | "failed";

export interface SearchState {
	readonly request: SearchRequest | null;
	readonly hits: readonly SearchHit[];
	/** The local search answered for this request. */
	readonly localReady: boolean;
	readonly server: ServerSearchStatus;
	/** The server has more pages (more()). */
	readonly hasMore: boolean;
	readonly loadingMore: boolean;
}

export interface SearchSessionTimers {
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface SearchSessionOptions {
	readonly local: (text: string, options: SearchOptions) => Promise<readonly StoredMessage[]>;
	readonly server: (request: ServerSearchRequest) => Promise<ServerSearchResult>;
	readonly timers: SearchSessionTimers;
	/** Whether the device is online at the start (default true); see setOnline. */
	readonly online?: boolean;
	/** Pause in typing before the server is asked. */
	readonly debounceMs?: number;
	readonly localLimit?: number;
	readonly serverLimit?: number;
	readonly onChange: (state: SearchState) => void;
}

/** 350 ms: past a typing burst (≈ 150–250 ms between keys), well inside the 1 s "results after a pause" feel. */
export const SERVER_DEBOUNCE_MS = 350;

export const IDLE_SEARCH: SearchState = { request: null, hits: [], localReady: true, server: "idle", hasMore: false, loadingMore: false };

/** A request with words or filters; anything else searches nothing. */
export function isSearchable(request: SearchRequest): boolean {
	return searchText(request.text) !== "" || hasFilters(request.filters);
}

function sameRequest(a: SearchRequest | null, b: SearchRequest): boolean {
	return (
		a !== null &&
		a.text.trim() === b.text.trim() &&
		a.chatId === b.chatId &&
		a.topicId === b.topicId &&
		JSON.stringify(a.filters) === JSON.stringify(b.filters)
	);
}

export class SearchSession {
	private generation = 0;
	private state: SearchState = IDLE_SEARCH;
	private localHits: readonly StoredMessage[] = [];
	private serverHits: StoredMessage[] = [];
	private cursor = "";
	private serverAnswered = false;
	private timer: unknown = null;
	private online: boolean;

	constructor(private readonly options: SearchSessionOptions) {
		this.online = options.online ?? true;
	}

	/**
	 * Tells the session whether the device is online. Offline the server is
	 * not asked (state "offline"); coming back online asks it at once.
	 */
	setOnline(online: boolean): void {
		if (this.online === online) return;
		this.online = online;
		if (online && this.state.server === "offline") this.retry();
	}

	current(): SearchState {
		return this.state;
	}

	/** Starts searching for `request` (no-op when it is the current one). */
	set(request: SearchRequest): void {
		if (sameRequest(this.state.request, request)) return;
		this.cancel();
		const generation = ++this.generation;
		this.localHits = [];
		this.serverHits = [];
		this.cursor = "";
		this.serverAnswered = false;
		if (!isSearchable(request)) {
			this.emit({ ...IDLE_SEARCH, request });
			return;
		}
		const online = this.online;
		this.emit({ request, hits: [], localReady: false, server: online ? "waiting" : "offline", hasMore: false, loadingMore: false });
		const local: SearchOptions = {
			chatId: request.chatId,
			topicId: request.topicId,
			filters: request.filters,
			limit: this.options.localLimit ?? 50,
		};
		this.options.local(request.text, local).then(
			(hits) => {
				if (generation !== this.generation) return;
				this.localHits = hits;
				this.emit({ ...this.state, localReady: true, hits: this.merged() });
			},
			() => {
				if (generation !== this.generation) return;
				this.emit({ ...this.state, localReady: true });
			},
		);
		if (online) {
			this.timer = this.options.timers.setTimeout(() => {
				this.timer = null;
				void this.fetch(generation, false);
			}, this.options.debounceMs ?? SERVER_DEBOUNCE_MS);
		}
	}

	/** Loads the next server page. */
	more(): void {
		if (!this.state.hasMore || this.state.loadingMore || this.state.server === "loading") return;
		void this.fetch(this.generation, true);
	}

	/** Asks the server again after a failure or once back online. */
	retry(): void {
		const { request, server } = this.state;
		if (request === null || (server !== "failed" && server !== "offline")) return;
		this.cancel();
		void this.fetch(this.generation, this.serverAnswered);
	}

	/**
	 * Stops timers and ignores answers still on their way. The session can
	 * be used again: the next set() starts afresh, even for the same request.
	 */
	dispose(): void {
		this.cancel();
		this.generation++;
		this.state = IDLE_SEARCH;
	}

	private cancel(): void {
		if (this.timer !== null) this.options.timers.clearTimeout(this.timer);
		this.timer = null;
	}

	private async fetch(generation: number, next: boolean): Promise<void> {
		const request = this.state.request;
		if (request === null) return;
		this.emit(next ? { ...this.state, loadingMore: true } : { ...this.state, server: "loading" });
		let result: ServerSearchResult;
		try {
			result = await this.options.server({
				query: request.text,
				chatId: request.chatId,
				topicId: request.topicId,
				filters: request.filters,
				cursor: next ? this.cursor : "",
				limit: this.options.serverLimit ?? SERVER_PAGE,
			});
		} catch {
			result = { ok: false, failure: "retryable" };
		}
		if (generation !== this.generation) return;
		if (!result.ok) {
			const offline = result.failure === "retryable" && !this.online;
			this.emit({ ...this.state, server: offline ? "offline" : "failed", loadingMore: false });
			return;
		}
		if (!next) this.serverHits = [];
		this.serverHits.push(...result.page.messages);
		this.cursor = result.page.nextCursor;
		this.serverAnswered = true;
		this.emit({ ...this.state, server: "done", hasMore: this.cursor !== "", loadingMore: false, hits: this.merged() });
	}

	private merged(): SearchHit[] {
		const server = this.serverAnswered ? { messages: this.serverHits, complete: this.cursor === "" } : null;
		const hits = mergeSearchHits(this.localHits, server);
		return this.state.request !== null && this.state.request.chatId !== 0 ? sortNewestFirst(hits) : hits;
	}

	private emit(state: SearchState): void {
		this.state = state;
		this.options.onChange(state);
	}
}
