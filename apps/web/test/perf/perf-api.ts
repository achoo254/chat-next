// What the perf page of the visual harness (test/visual/perf.tsx) exposes on
// `window.perfHarness`, and the seed it builds. The gate runner drives the
// page through this interface only.

/** Seed of the perf page: chat list and history sizes from the speed budget. */
export const PERF_SEED = {
	/** Chats in the list (the list scroll scenario). */
	chats: 1_000,
	/** Messages in the long chat (the history scroll scenario). */
	longChatMessages: 5_000,
	/** History the message scroll scenario must travel through. */
	scrolledMessages: 1_000,
} as const;

/** Raw samples; the runner turns them into statistics (stats.ts). */
export interface ScrollSample {
	/** requestAnimationFrame timestamps while scrolling, ms. */
	readonly frames: readonly number[];
	/** Long tasks seen while scrolling, ms each. */
	readonly longTasks: readonly number[];
	/** Rows (chat list) or messages (history) the scroll travelled through. */
	readonly travelled: number;
}

export interface OpenSample {
	/** Click on a chat row to the first frame showing its messages, ms each. */
	readonly openMs: readonly number[];
	readonly longTasks: readonly number[];
}

export interface PerfHarness {
	/** Resolves once the chat list shows its rows and the page has gone quiet. */
	ready(): Promise<{ readonly chats: number }>;
	/** Opens the cached chats in turn `rounds` times after one warm-up pass each. */
	openCachedChats(rounds: number): Promise<OpenSample>;
	/** Scrolls the chat list top to bottom, `stepPx` per frame. */
	scrollChatList(stepPx: number): Promise<ScrollSample>;
	/** Opens the long chat and scrolls up through `messages` of history, `stepPx` per frame. */
	scrollHistory(messages: number, stepPx: number): Promise<ScrollSample>;
}

declare global {
	interface Window {
		perfHarness?: PerfHarness;
	}
}
