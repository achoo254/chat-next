// What the inspector panel says about the person you opened: a plain record of
// facts the panel words in the viewer's language (this file has no text). Pure:
// it reads the person's placement (the same one the 3D and 2D views draw, so the
// panel never disagrees with the scene), the office state and the viewer's
// clock. Only what the office wire already carries: no model, no file names, no
// token counts per person. A person who is gone (a machine whose command ended)
// gives null; the view keeps the last record and says they left.
import { STUDIO_TITLES, type CastKey } from "./office-cast.ts";
import type { LifeAct, LifeSlot } from "./office-life-schedule.ts";
import { markerStatus, workSubject, type MarkerStatus } from "./office-names.ts";
import { ADVISOR_ROOM, type Placement } from "./office-placement.ts";
import type { RoomCode } from "./office-rooms.ts";
import type { AnimGroup, OfficeState, ServiceKind } from "./office-state.ts";
import type { TimelineResult } from "./office-timeline.ts";

export type InspectorKind = "director" | "advisor" | "employee" | "machine";

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
	/** The placement key: "director", "advisor", "title:<castKey>" or "machine:<actor id>". */
	readonly key: string;
	readonly kind: InspectorKind;
	/** The job title of an employee. */
	readonly title: CastKey | null;
	/** The person's own room (their desk's); null for a machine. */
	readonly homeRoom: RoomCode | null;
	/** The room they are in now. */
	readonly room: RoomCode;
	readonly status: MarkerStatus;
	readonly mode: InspectorMode;
	/** Off duty on the living floor: the part of the day and what they do. */
	readonly life: { readonly slot: LifeSlot; readonly act: LifeAct } | null;
	readonly work: InspectorWork | null;
	/** What a background machine runs. */
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
	const working = p.activityRoom !== null && activity !== null && kind !== "machine";
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
