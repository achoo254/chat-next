// Member lists and invite links shared by the info panel and the admin page.
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { Invite, Member, Remote } from "../data/remote.ts";
import { useServices } from "../data/services.tsx";
import { rememberPresence } from "./presence.tsx";

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
	const key = `${chatId}|${query}|${attempt}`;

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
