// Groups and channels you share with someone (GetCommonChats): "N nhóm chung"
// on profiles, the 1-1 info column and the contacts card
// (mockups/chat.html#user-profile, #info-panels, #contacts), and "Có trong
// N nhóm của bạn" for bots. Loaded once per person and kept a minute.
import { useEffect, useState } from "react";
import { Link, paths } from "../../router.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import type { CommonChat, Remote } from "../data/remote.ts";
import { useServices } from "../data/services.tsx";
import { ChatAvatar } from "./parts.tsx";

const TTL_MS = 60_000;

export interface CommonChats {
	readonly chats: readonly CommonChat[];
	readonly count: number;
}

const cache = new WeakMap<Remote, Map<number, { at: number; value: CommonChats }>>();

function cached(remote: Remote, userId: number): CommonChats | null {
	const entry = cache.get(remote)?.get(userId);
	return entry !== undefined && Date.now() - entry.at < TTL_MS ? entry.value : null;
}

/** The chats shared with `userId` (0: none asked); null while loading or when the server refuses. */
export function useCommonChats(userId: number): CommonChats | null {
	const { remote } = useServices();
	const known = userId === 0 ? null : cached(remote, userId);
	const [loaded, setLoaded] = useState<{ userId: number; value: CommonChats } | null>(null);
	useEffect(() => {
		if (userId === 0 || known !== null) return;
		let active = true;
		remote.commonChats(userId).then(
			(value) => {
				let byUser = cache.get(remote);
				if (byUser === undefined) {
					byUser = new Map();
					cache.set(remote, byUser);
				}
				byUser.set(userId, { at: Date.now(), value });
				if (active) setLoaded({ userId, value });
			},
			() => undefined,
		);
		return () => {
			active = false;
		};
	}, [remote, userId, known]);
	if (known !== null) return known;
	return loaded?.userId === userId ? loaded.value : null;
}

/** The section listing shared chats; nothing while loading. */
export function CommonChatsSection({ userId, bot = false }: { userId: number; bot?: boolean }) {
	const copy = useScreensCopy();
	const common = useCommonChats(userId);
	if (common === null) return null;
	const title = bot ? copy.profile.botIn(common.count) : common.count === 0 ? copy.profile.noCommonGroups : copy.profile.commonGroups(common.count);
	return (
		<div className="info-sec">
			<h3>{title}</h3>
			{common.chats.map((chat) => (
				<Link key={chat.id} to={paths.chat(chat.id)} className="row link-row">
					<ChatAvatar id={chat.id} name={chat.title} size="sm" />
					<span className="grow">
						{chat.title}
						<small>{chat.channel ? copy.info.channel(chat.memberCount) : copy.convo.members(chat.memberCount)}</small>
					</span>
				</Link>
			))}
		</div>
	);
}
