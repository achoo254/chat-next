// What the inspector panel says about the person you opened: a plain record of
// facts the panel words in the viewer's language (this file has no text). Pure:
// it reads the person's placement (the same one the 3D and 2D views draw, so the
// panel never disagrees with the scene), the office state and the viewer's
// clock. Only what the office wire already carries: no model, no file names, no
// token counts per person. A person who is not placed gives null; the view
// keeps the last record and says they left.
import { STUDIO_TITLES, type CastKey } from "./office-cast.ts";
import type { LifeAct, LifeSlot } from "./office-life-schedule.ts";
import { markerStatus, workSubject, type MarkerStatus } from "./office-names.ts";
import { ADVISOR_ROOM, type Placement } from "./office-placement.ts";
import type { RoomCode } from "./office-rooms.ts";
import type { AnimGroup, OfficeState, ServiceKind } from "./office-state.ts";
import type { TimelineResult } from "./office-timeline.ts";

export type InspectorKind = "director" | "advisor" | "employee";

/**
 * "work": at work now (real events say so); "life": off duty on the living floor,
 * a simulation of a daily schedule and not the AI's work; "idle": at their seat
 * with nothing running.
 */
export type InspectorMode = "work" | "life" | "idle";

export interface InspectorWork {
	/** The tool as the agent named it; "" for coming in, handing in and thinking (the group says which). */
	readonly tool: string;
	readonly group: AnimGroup;
	readonly room: RoomCode;
	/** What the bubble shows after the tool's name; "" for none (see workSubject). */
	readonly subject: string;
	/** How long it has run, ms; 0 when its start is not known. */
	readonly runningMs: number;
	/** Running over two minutes (an hourglass). */
	readonly slow: boolean;
	/** Dozing off over a long tool: how long they have been silent (ms); null otherwise. */
	readonly stuckMs: number | null;
}

export interface InspectorService {
	readonly kind: ServiceKind;
	readonly port: number | null;
	readonly uptimeMs: number;
}

export interface InspectorEntry {
	readonly group: AnimGroup;
	readonly room: RoomCode;
	readonly result: TimelineResult;
	readonly ms: number;
	/** How long ago it ended, ms. */
	readonly agoMs: number;
}

export interface InspectorModel {
	/** The placement key: "director", "advisor" or "title:<castKey>". */
	readonly key: string;
	readonly kind: InspectorKind;
	/** The job title of an employee. */
	readonly title: CastKey | null;
	/** The person's own room (their desk's). */
	readonly homeRoom: RoomCode | null;
	/** The room they are in now. */
	readonly room: RoomCode;
	readonly status: MarkerStatus;
	readonly mode: InspectorMode;
	/** Off duty on the living floor: the part of the day and what they do. */
	readonly life: { readonly slot: LifeSlot; readonly act: LifeAct } | null;
	readonly work: InspectorWork | null;
	/** What the background service they run is (shown on its owner title's person); null when none. */
	readonly service: InspectorService | null;
	/** A subagent's one-line description; Advisor's latest answer; "" for anyone else. */
	readonly description: string;
	/** How many subagents of the person's title are at work at once. */
	readonly concurrent: number;
	/** How the latest activity that said how it ended ended; null before one. */
	readonly lastResult: { readonly ok: boolean; readonly agoMs: number } | null;
	/** Activities finished this session. */
	readonly done: number;
	/** How long the person's latest approval waited (ms); null before one. */
	readonly approvalWaitMs: number | null;
	/** The latest finished activities, newest first. Built on this device from the events seen since the office opened. */
	readonly timeline: readonly InspectorEntry[];
	/** A new snapshot is awaited or the power is out: what shows may be out of date. */
	readonly stale: boolean;
}

/** `machineMs` (machine time) as a duration before viewer time `now`. */
function agoOf(machineMs: number, state: OfficeState, now: number): number {
	return Math.max(0, now - (machineMs + state.clockOffset));
}

function kindOf(p: Placement): InspectorKind | null {
	return p.kind === "chairman" ? null : p.kind;
}

/** The person with this key among the placements, as the panel shows them; null when they are not there (or are the chairman, who is not inspected). */
export function inspectorOf(placements: readonly Placement[], key: string, state: OfficeState, now: number): InspectorModel | null {
	const p = placements.find((x) => x.key === key);
	if (p === undefined) return null;
	const kind = kindOf(p);
	if (kind === null) return null;
	const title = kind === "employee" ? (STUDIO_TITLES.find((t) => `title:${t.key}` === p.key) ?? null) : null;
	const homeRoom: RoomCode | null = kind === "director" ? "DIRECTOR" : kind === "advisor" ? ADVISOR_ROOM : (title?.homeRoom ?? null);
	const actor = p.actor;
	const activity = actor?.activity ?? null;
	const service = actor?.service ?? null;
	const person = state.timeline[p.key];
	const entries: InspectorEntry[] = (person?.entries ?? []).map((e) => ({ group: e.group, room: e.room, result: e.result, ms: e.ms, agoMs: agoOf(e.at, state, now) }));
	const known = (person?.entries ?? []).find((e) => e.result !== "unknown");
	const working = p.activityRoom !== null && activity !== null;
	const mode: InspectorMode = p.activityRoom !== null ? "work" : p.life !== null ? "life" : "idle";
	return {
		key: p.key,
		kind,
		title: title?.key ?? null,
		homeRoom,
		room: p.room,
		status: markerStatus(p.kind, actor),
		mode,
		life: p.activityRoom === null ? p.life : null,
		work: working
			? {
					tool: activity.tool,
					group: activity.group,
					room: activity.room,
					subject: workSubject(p),
					runningMs: activity.startedAt > 0 ? Math.max(0, now - (activity.startedAt + state.clockOffset)) : 0,
					slow: activity.slow,
					stuckMs: activity.stuckMs,
				}
			: null,
		service: service === null ? null : { kind: service.kind, port: service.port, uptimeMs: service.uptimeMs },
		description: kind === "employee" || kind === "advisor" ? (actor?.description ?? "") : "",
		concurrent: p.concurrent,
		lastResult: known === undefined ? null : { ok: known.result === "ok", agoMs: agoOf(known.at, state, now) },
		done: person?.done ?? 0,
		approvalWaitMs: person?.approval?.waitMs ?? null,
		timeline: entries,
		stale: state.awaitingSnapshot || state.power === "out",
	};
}

/** How long the panel of someone who left says so before it closes (viewer time). */
export const LEFT_SHOWN_MS = 4_000;

/** What the panel shows for the person chosen: their record and placement as last seen, and since when they are gone (null while they are here). */
export interface HeldInspected {
	readonly key: string;
	readonly model: InspectorModel;
	readonly placement: Placement;
	readonly leftAt: number | null;
}

/**
 * The panel's content for the chosen person `key` (null: none chosen) at viewer
 * time `now`, and whether the panel should close. A person who is here shows as
 * they are. One who has gone keeps the record last seen with the time they
 * left, until LEFT_SHOWN_MS has passed; a key that was never shown closes at once. Pure:
 * `prev` is what this returned last.
 */
export function holdInspected(prev: HeldInspected | null, key: string | null, placements: readonly Placement[], state: OfficeState, now: number): { readonly shown: HeldInspected | null; readonly close: boolean } {
	if (key === null) return { shown: null, close: false };
	const model = inspectorOf(placements, key, state, now);
	const placement = placements.find((p) => p.key === key);
	if (model !== null && placement !== undefined) return { shown: { key, model, placement, leftAt: null }, close: false };
	if (prev === null || prev.key !== key) return { shown: null, close: true };
	const leftAt = prev.leftAt ?? now;
	return { shown: { ...prev, leftAt }, close: now - leftAt >= LEFT_SHOWN_MS };
}
