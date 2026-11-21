// What was unread in each of a person's chats when the screen opened, for the
// unread divider of the merged timeline. A chat is noted when its dialog is
// first known; a later dialog (the server's after the cached one) can only
// bring the position earlier or give one where there was none, so reading the
// messages (which empties the dialog's unread count) does not move the divider.
import { useMemo, useState, useSyncExternalStore } from "react";
import { useServices } from "../data/services.tsx";
import type { PersonMember } from "./people-api.ts";
import type { UnreadFrom } from "./merged-rows.ts";

/** Per chat the first unread seq (0: none unread); null until `ready` and every chat's dialog is known. */
export function useUnreadAtOpen(members: readonly Pick<PersonMember, "chatId">[], ready: boolean): UnreadFrom | null {
	// The snapshot reads the store's current dialogs: the compiler must not cache it.
	"use no memo";
	const { store } = useServices();
	const ids = members.filter((member) => member.chatId !== 0).map((member) => member.chatId);
	const key = ids.join(",");
	const subscribe = useMemo(
		() => (listener: () => void) => {
			const stops = key === "" ? [] : key.split(",").map((id) => store.subscribe(`dialog:${id}`, listener));
			return () => {
				for (const stop of stops) stop();
			};
		},
		[store, key],
	);
	// One string that changes only when a dialog's unread position does, so the snapshot is stable between renders.
	const snapshot = useSyncExternalStore(subscribe, () =>
		JSON.stringify(
			ids.map((chatId) => {
				const dialog = store.dialog(chatId)?.dialog;
				return dialog === undefined ? null : dialog.unreadCount > 0 ? dialog.readInboxMaxSeq + 1 : 0;
			}),
		),
	);
	const [noted, setNoted] = useState<ReadonlyMap<number, number>>(new Map());
	if (ready) {
		const facts: unknown = JSON.parse(snapshot);
		let next: Map<number, number> | null = null;
		ids.forEach((chatId, index) => {
			const fact = Array.isArray(facts) ? (facts[index] as number | null) : null;
			if (fact === null || fact === undefined) return;
			const before = noted.get(chatId);
			const earlier = before === undefined || before === 0 ? fact : fact === 0 ? before : Math.min(before, fact);
			if (earlier === before) return;
			next ??= new Map(noted);
			next.set(chatId, earlier);
		});
		if (next !== null) setNoted(next);
	}
	// Null until every chat is known: reading must not start before, or it would empty what is noted.
	return ready && ids.every((chatId) => noted.has(chatId)) ? noted : null;
}
