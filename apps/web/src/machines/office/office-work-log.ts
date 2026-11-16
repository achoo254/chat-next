// What each person of the office did this session, as normalized facts only
// (the kind and room of their last finished activity, whether it passed, how
// long it took, how many they finished, how long their last approval waited):
// what the residents talk about (office-conversations.ts). Never a command,
// a path or a file name: the activity's subject is not kept. Keyed by person
// ("director" or an employee's staff key), so an employee coming back to
// work keeps their record. Pure: the store calls these on its events.
import type { AnimGroup } from "./office-state.ts";
import type { RoomCode } from "./office-rooms.ts";

export interface LastWork {
	readonly group: AnimGroup;
	readonly room: RoomCode;
	readonly ok: boolean;
	/** Machine time it ended. */
	readonly at: number;
	/** How long it ran, ms. */
	readonly ms: number;
}

export interface PersonWork {
	/** Activities finished this session. */
	readonly done: number;
	readonly last: LastWork | null;
	/** The latest approval this person waited for: how long, and when it was decided (machine time); null before one. */
	readonly approval: { readonly waitMs: number; readonly at: number } | null;
}

export type WorkLog = Readonly<Record<string, PersonWork>>;

export const EMPTY_WORK: PersonWork = { done: 0, last: null, approval: null };

/** `key` finished an activity. */
export function workEnded(log: WorkLog, key: string, work: LastWork): WorkLog {
	const before = log[key] ?? EMPTY_WORK;
	return { ...log, [key]: { ...before, done: before.done + 1, last: work } };
}

/** `key`'s approval was decided after waiting `waitMs`. */
export function approvalDecided(log: WorkLog, key: string, waitMs: number, at: number): WorkLog {
	const before = log[key] ?? EMPTY_WORK;
	return { ...log, [key]: { ...before, approval: { waitMs: Math.max(0, waitMs), at } } };
}
