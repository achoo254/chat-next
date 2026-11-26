// The tags members of a synced group carry beside their name (Telegram's custom titles,
// "BJ", "Nháy"), for the sender line of messages. Read from the member list once per chat
// and kept a few minutes, so the bubbles of a chat share one request.
import { useEffect, useSyncExternalStore } from "react";
import type { Remote } from "../data/remote.ts";
import { useServices } from "../data/services.tsx";

/** Tags are read again after this long, for a chat still on screen. */
const RANKS_FRESH_MS = 5 * 60_000;
/** Pages of the member list read for tags; a bigger group shows the tags of the first ones. */
const RANK_PAGES_MAX = 5;

class MemberRanks {
	private readonly byChat = new Map<number, { at: number; ranks: ReadonlyMap<number, string> }>();
	private readonly loading = new Set<number>();
	private readonly listeners = new Set<() => void>();

	get(chatId: number, userId: number): string {
		return this.byChat.get(chatId)?.ranks.get(userId) ?? "";
	}

	load(remote: Remote, chatId: number): void {
		const known = this.byChat.get(chatId);
		if (this.loading.has(chatId) || (known !== undefined && Date.now() - known.at < RANKS_FRESH_MS)) return;
		this.loading.add(chatId);
		this.read(remote, chatId)
			.then(
				(ranks) => {
					this.byChat.set(chatId, { at: Date.now(), ranks });
					for (const listener of [...this.listeners]) listener();
				},
				// Offline: the sender line shows the name alone.
				() => undefined,
			)
			.finally(() => this.loading.delete(chatId));
	}

	private async read(remote: Remote, chatId: number): Promise<ReadonlyMap<number, string>> {
		const ranks = new Map<number, string>();
		let cursor = "";
		for (let page = 0; page < RANK_PAGES_MAX; page++) {
			const { members, nextCursor } = await remote.members(chatId, "", cursor);
			for (const member of members) if (member.rank !== "") ranks.set(member.person.id, member.rank);
			if (nextCursor === "") break;
			cursor = nextCursor;
		}
		return ranks;
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
}

/** One cache per client, so a new session (or test) never sees another one's tags. */
const ranksByRemote = new WeakMap<Remote, MemberRanks>();

function ranksOf(remote: Remote): MemberRanks {
	let ranks = ranksByRemote.get(remote);
	if (ranks === undefined) {
		ranks = new MemberRanks();
		ranksByRemote.set(remote, ranks);
	}
	return ranks;
}

/** The tag of a member of a group; "" for none. `chatId` 0 reads nothing. */
export function useMemberRank(chatId: number, userId: number): string {
	const { remote } = useServices();
	const ranks = ranksOf(remote);
	useEffect(() => {
		if (chatId !== 0) ranks.load(remote, chatId);
	}, [ranks, remote, chatId]);
	return useSyncExternalStore(ranks.subscribe, () => (chatId === 0 ? "" : ranks.get(chatId, userId)));
}
