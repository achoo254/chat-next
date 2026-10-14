// Presence as the other user's privacy allows ("online", "truy cập gần
// đây"). The core keeps no presence, so it is read from GetUsers and cached
// for a minute per user.
import { useEffect, useState } from "react";
import { useI18n } from "../../i18n/i18n.tsx";
import type { MessagingCopy } from "../copy/vi.ts";
import { clock, shortDate } from "../data/format.ts";
import type { Presence, Remote } from "../data/remote.ts";
import { useServices } from "../data/services.tsx";

const TTL_MS = 60_000;
const cache = new WeakMap<Remote, Map<number, { at: number; presence: Presence }>>();

function cached(remote: Remote, userId: number): Presence | null {
	const entry = cache.get(remote)?.get(userId);
	return entry !== undefined && Date.now() - entry.at < TTL_MS ? entry.presence : null;
}

export function rememberPresence(remote: Remote, userId: number, presence: Presence): void {
	let map = cache.get(remote);
	if (map === undefined) {
		map = new Map();
		cache.set(remote, map);
	}
	map.set(userId, { at: Date.now(), presence });
}

export function usePresence(userId: number): Presence | null {
	const { remote } = useServices();
	const [loaded, setLoaded] = useState<{ userId: number; presence: Presence } | null>(null);
	const known = userId === 0 ? null : cached(remote, userId);
	useEffect(() => {
		if (userId === 0 || known !== null) return;
		let active = true;
		remote.people([userId]).then(
			(people) => {
				const person = people[0];
				if (person === undefined || !active) return;
				rememberPresence(remote, userId, person.presence);
				setLoaded({ userId, presence: person.presence });
			},
			() => undefined,
		);
		return () => {
			active = false;
		};
	}, [remote, userId, known]);
	if (known !== null) return known;
	return loaded?.userId === userId ? loaded.presence : null;
}

export function presenceText(presence: Presence, copy: MessagingCopy, locale = "vi"): string {
	switch (presence.kind) {
		case "online":
			return copy.info.online;
		case "offline": {
			const sameDay = new Date(presence.lastSeen * 1000).toDateString() === new Date().toDateString();
			return copy.info.lastSeen(sameDay ? clock(presence.lastSeen, locale) : shortDate(presence.lastSeen, locale));
		}
		case "recently":
			return copy.info.recently;
		case "last_week":
			return copy.info.lastWeek;
		case "last_month":
			return copy.info.lastMonth;
		case "hidden":
			return copy.info.longAgo;
	}
}

/** presenceText in the current locale. */
export function usePresenceText(presence: Presence | null, copy: MessagingCopy): string {
	const { locale } = useI18n();
	return presence === null ? "" : presenceText(presence, copy, locale);
}
