// "k đang hoạt động" of groups, for the conversation header (which ships
// with the first screen) and the info panel; kept apart from members.ts so
// the header does not load the member lists.
import { useEffect, useSyncExternalStore } from "react";
import type { ChatSource } from "../data/source.ts";
import { useServices } from "../data/services.tsx";

/** "k đang hoạt động" is refreshed this often while the chat is on screen. */
export const ONLINE_REFRESH_MS = 60_000;
/** Mounts within this window (header and info panel together) share one request. */
const ONLINE_FRESH_MS = 10_000;

/** "k đang hoạt động" of groups, counted by the server (GetChatOnlineCount). */
class OnlineCounts {
	private readonly byChat = new Map<number, { at: number; count: number }>();
	private readonly loading = new Set<number>();
	private readonly listeners = new Set<() => void>();

	get(chatId: number): number | null {
		return this.byChat.get(chatId)?.count ?? null;
	}

	load(source: ChatSource, chatId: number): void {
		const known = this.byChat.get(chatId);
		if (this.loading.has(chatId) || (known !== undefined && Date.now() - known.at < ONLINE_FRESH_MS)) return;
		this.loading.add(chatId);
		source
			.onlineCount(chatId)
			.then(
				(count) => {
					const previous = this.byChat.get(chatId)?.count;
					this.byChat.set(chatId, { at: Date.now(), count });
					if (previous !== count) for (const listener of [...this.listeners]) listener();
				},
				// Offline or an older server: the header shows the member count alone.
				() => undefined,
			)
			.finally(() => this.loading.delete(chatId));
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
}

/** One cache per client, so a new session (or test) never sees another one's counts. */
const onlineCountsBySource = new WeakMap<ChatSource, OnlineCounts>();

function onlineCountsOf(source: ChatSource): OnlineCounts {
	let counts = onlineCountsBySource.get(source);
	if (counts === undefined) {
		counts = new OnlineCounts();
		onlineCountsBySource.set(source, counts);
	}
	return counts;
}

/**
 * Members of a group online now, me included (as the server counts); null
 * while unknown, for chatId 0 and when nobody but me is, so the header shows
 * the member count alone instead of "1 đang hoạt động", as Telegram does.
 * Asked when the chat opens, again every minute while the page is visible,
 * and when the page becomes visible again.
 */
export function useOnlineCount(chatId: number): number | null {
	const { source } = useServices();
	const onlineCounts = onlineCountsOf(source);
	useEffect(() => {
		if (chatId === 0) return;
		const refresh = () => {
			if (document.visibilityState !== "hidden") onlineCounts.load(source, chatId);
		};
		refresh();
		const timer = setInterval(refresh, ONLINE_REFRESH_MS);
		document.addEventListener("visibilitychange", refresh);
		return () => {
			clearInterval(timer);
			document.removeEventListener("visibilitychange", refresh);
		};
	}, [source, onlineCounts, chatId]);
	return useSyncExternalStore(onlineCounts.subscribe, () => {
		const count = chatId === 0 ? null : onlineCounts.get(chatId);
		return count !== null && count <= 1 ? null : count;
	});
}
