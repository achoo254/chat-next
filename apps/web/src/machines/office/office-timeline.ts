// What each person of the office did this session, as the inspector panel reads
// it: the last few finished activities, how many were finished and the latest
// approval wait. Normalized facts only (the kind and room of the activity, how
// it ended, how long it ran): never its subject, a command or a path. It is
// built on this device from the events it received, so it starts when the
// viewer opened the office and is empty again after a reload.
//
// Keyed by the inspector's person key ("director", "advisor", "title:<castKey>"),
// not by the staff key the work log uses: several subagents of one job title are
// one person, and the director's tool handed to a department, like a background
// service's run, is credited to the person the bubble shows it on.
// Pure: the store calls these on its events.
import type { AnimGroup } from "./office-state.ts";
import type { RoomCode } from "./office-rooms.ts";

/** How many finished activities each person keeps. */
export const TIMELINE_LIMIT = 8;

/** "unknown": the activity was replaced or cut off without the agent saying how it ended. */
export type TimelineResult = "ok" | "failed" | "unknown";

export interface TimelineEntry {
	readonly group: AnimGroup;
	readonly room: RoomCode;
	readonly result: TimelineResult;
	/** How long it ran, ms; 0 when its start is not known. */
	readonly ms: number;
	/** Machine time it ended. */
	readonly at: number;
}

export interface PersonTimeline {
	/** Finished activities this session, newest first, at most TIMELINE_LIMIT. */
	readonly entries: readonly TimelineEntry[];
	/** Activities finished this session (the entries are only the latest). */
	readonly done: number;
	/** The latest approval this person waited for: how long, and when it was decided (machine time); null before one. */
	readonly approval: { readonly waitMs: number; readonly at: number } | null;
}

export type Timeline = Readonly<Record<string, PersonTimeline>>;

export const EMPTY_PERSON_TIMELINE: PersonTimeline = { entries: [], done: 0, approval: null };

/** Groups that are not work a person finishes: coming in, handing in a file, thinking. */
const NOT_WORK: ReadonlySet<AnimGroup> = new Set<AnimGroup>(["arrive", "hand-in", "think"]);

/** Whether a finished activity of this group belongs on the timeline. */
export function countsAsWork(group: AnimGroup): boolean {
	return !NOT_WORK.has(group);
}

/** `key` finished an activity. Coming in, handing in and thinking are not counted. */
export function timelineEnded(timeline: Timeline, key: string, entry: TimelineEntry): Timeline {
	if (!countsAsWork(entry.group)) return timeline;
	const before = timeline[key] ?? EMPTY_PERSON_TIMELINE;
	return { ...timeline, [key]: { ...before, entries: [entry, ...before.entries].slice(0, TIMELINE_LIMIT), done: before.done + 1 } };
}

/** `key`'s approval was decided after waiting `waitMs`. */
export function timelineApproval(timeline: Timeline, key: string, waitMs: number, at: number): Timeline {
	const before = timeline[key] ?? EMPTY_PERSON_TIMELINE;
	return { ...timeline, [key]: { ...before, approval: { waitMs: Math.max(0, waitMs), at } } };
}
