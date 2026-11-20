// The merged timeline of the person on screen: one MergedTimeline per person
// (and per set of their chats, so linking or unlinking an identity starts a
// fresh one), opened when the screen shows it and disposed when it leaves.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useServices } from "../data/services.tsx";
import type { LinkedPerson, PersonMember } from "./people-api.ts";
import { MergedTimeline, type MergedTimelineSnapshot } from "./merged-timeline.ts";

const EMPTY: MergedTimelineSnapshot = { status: "loading", items: [], hasOlder: false, loadingOlder: false, failures: new Map() };

/**
 * The timeline the screen has open now. It is created in an effect, not
 * during render, so a remount (StrictMode) disposes one and opens another;
 * this slot tells the subscribers which one is current.
 */
class TimelineSlot {
	private timeline: MergedTimeline | null = null;
	private readonly listeners = new Set<() => void>();
	private detach: () => void = () => undefined;

	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	readonly current = (): MergedTimeline | null => this.timeline;

	readonly snapshot = (): MergedTimelineSnapshot => this.timeline?.snapshot() ?? EMPTY;

	set(timeline: MergedTimeline | null): void {
		this.detach();
		this.timeline = timeline;
		this.detach = timeline === null ? () => undefined : timeline.subscribe(() => this.notify());
		this.notify();
	}

	private notify(): void {
		for (const listener of [...this.listeners]) listener();
	}
}

/** The chat and app of each identity with a private chat, as one string that changes only when they do. */
function chatsKey(members: readonly PersonMember[]): string {
	return JSON.stringify(members.filter((member) => member.chatId !== 0).map((member) => [member.chatId, member.app]));
}

function membersOf(key: string): Pick<PersonMember, "chatId" | "app">[] {
	const pairs: unknown = JSON.parse(key);
	if (!Array.isArray(pairs)) return [];
	return pairs.flatMap((pair: unknown) => {
		if (!Array.isArray(pair) || typeof pair[0] !== "number" || typeof pair[1] !== "string") return [];
		return [{ chatId: pair[0], app: pair[1] }];
	});
}

/** The timeline (null until the screen has opened it) and what it shows now. */
export function useMergedTimeline(person: LinkedPerson): [MergedTimeline | null, MergedTimelineSnapshot] {
	// slot.current() changes without its arguments changing: the compiler must not cache it.
	"use no memo";
	const { source, store } = useServices();
	const chats = chatsKey(person.members);
	const slot = useMemo(() => new TimelineSlot(), []);

	useEffect(() => {
		const timeline = new MergedTimeline({
			source,
			members: membersOf(chats),
			onError: (error, context) => store.reportError(error, context),
		});
		timeline.open();
		slot.set(timeline);
		return () => {
			slot.set(null);
			timeline.dispose();
		};
	}, [slot, source, store, person.id, chats]);

	const snapshot = useSyncExternalStore(slot.subscribe, slot.snapshot);
	return [slot.current(), snapshot];
}
