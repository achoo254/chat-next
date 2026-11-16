// Where everyone in the office is: floor, room and the anchor they stand or
// sit at, from the store's state, the layout and the clock. Shared by the 2D
// and 3D views. The agent picks the room of each activity on the machine; here:
// an agent type's home room replaces WORK; with nothing to do an employee goes
// to their desk (or the meeting room without one, or as a nested subagent),
// the director to their office; a pending approval takes the person to
// Security; the chairman waits in the lobby. Short tools must not send people
// running between floors: whoever entered a room stays at least MIN_STAY_MS,
// and after the work there ends lingers LINGER_MS (gathering the next tools)
// before going home. The speech bubble shows the real tool at once anyway.
// Nobody leaves the building: whoever is off duty (the director while the
// session rests, a finished employee, a resident whose subagent left) lives
// by the daily schedule (office-life-schedule.ts) on the living floor, and
// spends office hours on the work floors as before (a resident in their
// agent type's home room). Real work always wins over the schedule.
// Pure: the memory of the last call goes in, the new one comes out.
import { homeRoomOf } from "./office-cast.ts";
import { anchorById, anchorOfKind, floorOfRoom, spotsOf } from "./office-geometry.ts";
import type { LayoutAnchor, OfficeLayout } from "./office-layout.ts";
import { allocateLifePlaces } from "./office-life-places.ts";
import { lifeActAt, lifePlanAt, type LifeAct, type LifePlan, type LifeSlot } from "./office-life-schedule.ts";
import type { FloorLevel, RoomCode } from "./office-rooms.ts";
import type { ActorView, OfficeState, StaffMember } from "./office-store.ts";

/** Whoever entered a room stays at least this long. */
export const MIN_STAY_MS = 4_000;
/** After the work in a room ends, its person stays this long before going home. */
export const LINGER_MS = 6_000;
/**
 * A finished employee's "hand-in" stays their activity on the wire (the agent
 * keeps it until they leave): the visit to the director lasts this long from
 * when it began, then they go home.
 */
export const HAND_IN_MS = 5_000;
/** At most this many residents (the director and employees, on duty or not) are shown; off-duty ones beyond it stay out of sight. */
export const MAX_RESIDENTS = 12;

export type PersonKind = "director" | "employee" | "machine" | "chairman";

export interface Placement {
	/** "director", "chairman", an employee's staff key, or "machine:<actor id>". */
	readonly key: string;
	readonly kind: PersonKind;
	/** The actor shown (null for the chairman and for an off-duty resident whose subagent left). */
	readonly actor: ActorView | null;
	/** The employee's staff entry (name, number, desk). */
	readonly member: StaffMember | null;
	readonly floor: FloorLevel;
	readonly room: RoomCode;
	readonly anchorId: string;
	/** Viewer time the person entered this room. */
	readonly since: number;
	/** The room the person works in now; null when free (idle play may take them to the pantry or around their desk). */
	readonly activityRoom: RoomCode | null;
	/** Off duty at a place of the living floor: the part of the day and what they do there; null otherwise. */
	readonly life: { readonly slot: LifeSlot; readonly act: LifeAct } | null;
}

interface Remembered {
	readonly room: RoomCode;
	readonly anchorId: string;
	readonly since: number;
	/** The last time the person worked in this room (viewer time); null if they did not. */
	readonly workedAt: number | null;
}

export type PlacementMemory = ReadonlyMap<string, Remembered>;

export const EMPTY_MEMORY: PlacementMemory = new Map();

interface Person {
	readonly key: string;
	readonly kind: PersonKind;
	readonly actor: ActorView | null;
	readonly member: StaffMember | null;
}

interface Wish {
	readonly room: RoomCode;
	readonly working: boolean;
	/** An anchor that is the person's own there: a desk, the director's chair, the chairman's spot, a place of the living floor. */
	readonly own: string | null;
	/** Off duty outside office hours: the schedule's plan (the place is allocated with everyone else's). */
	readonly life: LifePlan | null;
}

interface Decision {
	readonly person: Person;
	readonly room: RoomCode;
	readonly keep: string | null;
	readonly own: string | null;
	readonly since: number;
	readonly workedAt: number | null;
	readonly busy: boolean;
	readonly life: LifePlan | null;
}

function people(state: OfficeState): Person[] {
	const list: Person[] = [];
	const director = state.actors.find((a) => a.role === "director");
	if (director !== undefined) list.push({ key: "director", kind: "director", actor: director, member: null });
	for (const member of state.staff) {
		const actor = state.actors.find((a) => a.id === member.actorId);
		if (actor !== undefined) list.push({ key: member.key, kind: "employee", actor, member });
	}
	// Off-duty residents fill what the cap leaves, longest off duty first.
	const room = Math.max(0, MAX_RESIDENTS - list.length);
	for (const member of state.residents.slice(0, room)) list.push({ key: member.key, kind: "employee", actor: null, member });
	for (const actor of state.actors) if (actor.role === "machine") list.push({ key: `machine:${actor.id}`, kind: "machine", actor, member: null });
	if (state.chairman) list.push({ key: "chairman", kind: "chairman", actor: null, member: null });
	return list;
}

/** What the person does now: a finished employee's hand-in only for its visit. */
export function currentActivity(actor: ActorView, now: number, clockOffset: number): ActorView["activity"] {
	const a = actor.activity;
	if (a !== null && actor.state === "done" && a.group === "hand-in" && now - (a.startedAt + clockOffset) >= HAND_IN_MS) return null;
	return a;
}

/** A plan that sends the person to the living floor (outside office hours), or null. */
function livingPlan(key: string, now: number): LifePlan | null {
	const plan = lifePlanAt(key, now);
	return plan.kinds.length === 0 ? null : plan;
}

function wish(person: Person, layout: OfficeLayout, state: OfficeState, now: number): Wish {
	const actor = person.actor;
	if (person.kind === "chairman") return { room: "LOBBY", working: false, own: anchorOfKind(layout, "LOBBY", "chairman")?.id ?? null, life: null };
	if (actor === null) {
		// An off-duty resident: the living floor, or their agent type's home room in office hours.
		return { room: homeRoomOf(person.member?.agentType ?? ""), working: false, own: null, life: livingPlan(person.key, now) };
	}
	if (actor.state === "awaiting") return { room: "SECURITY", working: true, own: null, life: null };
	const deskId = person.member?.desk ?? null;
	const directorChair = anchorOfKind(layout, "DIRECTOR", "director")?.id ?? null;
	const activity = currentActivity(actor, now, state.clockOffset);
	if (activity !== null) {
		let room = activity.room;
		if (room === "WORK" && person.kind === "employee") room = homeRoomOf(actor.agentType);
		if (person.kind === "director" && room === "DIRECTOR") return { room, working: true, own: directorChair, life: null };
		return { room, working: true, own: room === "WORK" && person.kind === "employee" ? deskId : null, life: null };
	}
	if (person.kind === "machine") return { room: "SERVER", working: true, own: null, life: null };
	// Off duty: the director while the session rests, an employee whose subagent finished. Between two tools of a
	// running turn nobody is off duty (no running to bed and back).
	const offDuty = person.kind === "director" ? !state.session.busy : actor.state === "done";
	const life = offDuty ? livingPlan(person.key, now) : null;
	if (person.kind === "director") return { room: "DIRECTOR", working: false, own: directorChair, life };
	if (person.member?.nested === true || deskId === null) return { room: "MEETING", working: false, own: null, life };
	return { room: "WORK", working: false, own: deskId, life };
}

/** Everyone's wish, with the living floor's places allocated: the room and own place of whoever follows the schedule now. */
function wishes(list: readonly Person[], layout: OfficeLayout, state: OfficeState, now: number, memory: PlacementMemory): Wish[] {
	const raw = list.map((person) => wish(person, layout, state, now));
	const seekers = list.flatMap((person, i) => {
		const plan = raw[i]?.life ?? null;
		return plan === null ? [] : [{ key: person.key, plan, had: memory.get(person.key)?.anchorId ?? null }];
	});
	const places = allocateLifePlaces(layout, seekers, new Set());
	return raw.map((w, i) => {
		const place: LayoutAnchor | undefined = places.get(list[i]?.key ?? "");
		if (w.life === null) return w;
		// A layout without living places: the work floors, as in office hours.
		if (place === undefined || place.room === null) return { ...w, life: null };
		return { room: place.room, working: false, own: place.id, life: w.life };
	});
}

/** Everyone's place now, and the memory for the next call. Frozen while the power is out. */
export function officePlacement(
	state: OfficeState,
	layout: OfficeLayout,
	now: number,
	memory: PlacementMemory,
): { readonly placements: readonly Placement[]; readonly memory: PlacementMemory } {
	const frozen = state.power === "out";
	const decided: Decision[] = [];
	const everyone = people(state);
	const wanted = wishes(everyone, layout, state, now, memory);
	everyone.forEach((person, i) => {
		const want = wanted[i];
		if (want === undefined) return;
		const was = memory.get(person.key);
		if (was === undefined) {
			decided.push({ person, room: want.room, keep: null, own: want.own, since: now, workedAt: want.working ? now : null, busy: want.working, life: want.life });
			return;
		}
		// A clock set back (the viewer changed the time) never holds anyone: only time gone forward counts.
		const within = (since: number, ms: number): boolean => now >= since && now - since < ms;
		const lingering = !want.working && was.workedAt !== null && within(was.workedAt, LINGER_MS);
		const held = frozen || (want.room !== was.room && (within(was.since, MIN_STAY_MS) || lingering));
		if (held || want.room === was.room) {
			const working = want.room === was.room && want.working;
			decided.push({
				person,
				room: was.room,
				keep: was.anchorId,
				own: want.room === was.room ? want.own : null,
				since: was.since,
				workedAt: working && !frozen ? now : was.workedAt,
				busy: working || lingering || (held && was.workedAt !== null),
				life: want.room === was.room ? want.life : null,
			});
		} else decided.push({ person, room: want.room, keep: null, own: want.own, since: now, workedAt: want.working ? now : null, busy: want.working, life: want.life });
	});
	// Own anchors first, then those staying where they stood, then everyone else at the first free place of the room.
	const taken = new Set<string>();
	const anchorOf = new Map<string, string>();
	for (const d of decided) {
		if (d.own !== null) {
			anchorOf.set(d.person.key, d.own);
			taken.add(d.own);
		}
	}
	for (const d of decided) {
		if (anchorOf.has(d.person.key) || d.keep === null || taken.has(d.keep) || anchorById(layout, d.keep)?.room !== d.room) continue;
		anchorOf.set(d.person.key, d.keep);
		taken.add(d.keep);
	}
	const crowd = new Map<RoomCode, number>();
	for (const d of decided) {
		if (anchorOf.has(d.person.key)) continue;
		const spots = spotsOf(layout, d.room);
		const free = spots.find((a) => !taken.has(a.id));
		// A full room: people share places in turn (the views offset them).
		const extra = crowd.get(d.room) ?? 0;
		const chosen = free ?? spots[extra % Math.max(1, spots.length)];
		if (free === undefined) crowd.set(d.room, extra + 1);
		if (chosen !== undefined) {
			anchorOf.set(d.person.key, chosen.id);
			taken.add(chosen.id);
		}
	}
	const next = new Map<string, Remembered>();
	const placements = decided.map((d): Placement => {
		const anchorId = anchorOf.get(d.person.key) ?? "";
		next.set(d.person.key, { room: d.room, anchorId, since: d.since, workedAt: d.workedAt });
		// Living only once there and free (not while held back by work that just ended).
		const place = d.life === null || d.busy ? undefined : anchorById(layout, anchorId);
		return {
			key: d.person.key,
			kind: d.person.kind,
			actor: d.person.actor,
			member: d.person.member,
			floor: floorOfRoom(layout, d.room),
			room: d.room,
			anchorId,
			since: d.since,
			activityRoom: d.busy ? d.room : null,
			life: d.life === null || place === undefined ? null : { slot: d.life.slot, act: lifeActAt(place, d.life.slot, d.person.key, now) },
		};
	});
	return { placements, memory: next };
}
