// Member lists, the online count of groups and invite links, shared by
// the conversation header, the info panel and the admin page.
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { Invite, Member, Remote } from "../data/remote.ts";
import type { ChatSource } from "../data/source.ts";
import { useServices } from "../data/services.tsx";
import { rememberPresence } from "./presence.tsx";

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
 * Members of a group online now (null while unknown; chatId 0 for none).
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
	return useSyncExternalStore(onlineCounts.subscribe, () => (chatId === 0 ? null : onlineCounts.get(chatId)));
}

/** Per chat, bumped when this UI changes the members (remove, promote) so open lists reload. */
const memberChanges = new Map<number, number>();
const changeListeners = new Set<() => void>();

function subscribeChanges(listener: () => void): () => void {
	changeListeners.add(listener);
	return () => changeListeners.delete(listener);
}

export function membersChanged(chatId: number): void {
	memberChanges.set(chatId, (memberChanges.get(chatId) ?? 0) + 1);
	for (const listener of [...changeListeners]) listener();
}

export interface MembersState {
	readonly members: readonly Member[];
	readonly status: "loading" | "ready" | "error";
	readonly hasMore: boolean;
}

/** Members of a chat, filtered by `query` on the server, with paging. */
export function useMembers(chatId: number, query = "", enabled = true): MembersState & { more: () => void; reload: () => void } {
	const { remote } = useServices();
	const [state, setState] = useState<MembersState & { key: string; cursor: string }>({
		key: "",
		members: [],
		status: "loading",
		hasMore: false,
		cursor: "",
	});
	const [attempt, setAttempt] = useState(0);
	const changes = useSyncExternalStore(subscribeChanges, () => memberChanges.get(chatId) ?? 0);
	const key = `${chatId}|${query}|${attempt}|${changes}`;

	useEffect(() => {
		if (!enabled) return;
		let active = true;
		remote.members(chatId, query).then(
			(page) => {
				if (!active) return;
				for (const member of page.members) rememberPresence(remote, member.person.id, member.person.presence);
				setState({ key, members: page.members, status: "ready", hasMore: page.nextCursor !== "", cursor: page.nextCursor });
			},
			() => {
				if (active) setState({ key, members: [], status: "error", hasMore: false, cursor: "" });
			},
		);
		return () => {
			active = false;
		};
	}, [remote, chatId, query, key, enabled]);

	const more = useCallback(() => {
		if (state.cursor === "") return;
		remote.members(chatId, query, state.cursor).then(
			(page) =>
				setState((current) =>
					current.key !== key
						? current
						: {
								...current,
								members: [...current.members, ...page.members],
								hasMore: page.nextCursor !== "",
								cursor: page.nextCursor,
							},
				),
			() => undefined,
		);
	}, [remote, chatId, query, state.cursor, key]);

	const reload = useCallback(() => setAttempt((n) => n + 1), []);
	const current = state.key === key ? state : { members: [], status: "loading" as const, hasMore: false };
	return { members: current.members, status: current.status, hasMore: current.hasMore, more, reload };
}

/** Invite links per chat, loaded from the server and shared by the info panel and admin page. */
class InviteLinks {
	private readonly byChat = new Map<number, readonly Invite[]>();
	private readonly loading = new Set<number>();
	private readonly listeners = new Set<() => void>();
	private static readonly EMPTY: readonly Invite[] = [];

	list(chatId: number): readonly Invite[] {
		return this.byChat.get(chatId) ?? InviteLinks.EMPTY;
	}

	/** Loads the links once per chat; `force` reloads. */
	load(remote: Remote, chatId: number, force = false): void {
		if (this.loading.has(chatId) || (!force && this.byChat.has(chatId))) return;
		this.loading.add(chatId);
		remote
			.inviteLinks(chatId)
			.then(
				(links) => this.set(chatId, links),
				() => undefined,
			)
			.finally(() => this.loading.delete(chatId));
	}

	add(chatId: number, invite: Invite): void {
		this.set(chatId, [invite, ...this.list(chatId).filter((item) => item.link !== invite.link)]);
	}

	replace(chatId: number, invite: Invite): void {
		this.set(
			chatId,
			this.list(chatId).map((item) => (item.link === invite.link ? invite : item)),
		);
	}

	private set(chatId: number, links: readonly Invite[]): void {
		this.byChat.set(chatId, links);
		for (const listener of this.listeners) listener();
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
}

export const inviteLinks = new InviteLinks();

/** The chat's invite links (admins), loaded on first use. */
export function useInviteLinks(chatId: number, enabled = true): readonly Invite[] {
	const { remote } = useServices();
	useEffect(() => {
		if (enabled) inviteLinks.load(remote, chatId);
	}, [remote, chatId, enabled]);
	return useSyncExternalStore(inviteLinks.subscribe, () => inviteLinks.list(chatId));
}

/** A link that still works: not revoked, not expired, uses left. */
export function isActiveInvite(invite: Invite, nowMs: number): boolean {
	if (invite.revoked) return false;
	if (invite.expiresAt !== 0 && invite.expiresAt * 1000 <= nowMs) return false;
	return invite.usageLimit === 0 || invite.usageCount < invite.usageLimit;
}

/** Link as shown in rows: without the scheme. */
export function displayLink(link: string): string {
	return link.replace(/^https?:\/\//, "");
}
