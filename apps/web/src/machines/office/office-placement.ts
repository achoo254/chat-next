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
// Pure: the memory of the last call goes in, the new one comes out.
import { homeRoomOf } from "./office-cast.ts";
import { anchorById, anchorOfKind, deskOrder, floorOfRoom, spotsOf, type ScreenSize } from "./office-geometry.ts";
import type { OfficeLayout } from "./office-layout.ts";
import type { FloorLevel, RoomCode } from "./office-rooms.ts";
import type { ActorView, OfficeState, StaffMember } from "./office-store.ts";

/** Whoever entered a room stays at least this long. */
export const MIN_STAY_MS = 4_000;
/** After the work in a room ends, its person stays this long before going home. */
export const LINGER_MS = 6_000;

export type PersonKind = "director" | "employee" | "machine" | "chairman";

export interface Placement {
	/** "director", "chairman", an employee's staff key, or "machine:<actor id>". */
	readonly key: string;
	readonly kind: PersonKind;
	/** The actor shown (null for the chairman). */
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
	/** An anchor that is the person's own there: a desk, the director's chair, the chairman's spot. */
	readonly own: string | null;
}

function people(state: OfficeState): Person[] {
	const list: Person[] = [];
	const director = state.actors.find((a) => a.role === "director");
	if (director !== undefined) list.push({ key: "director", kind: "director", actor: director, member: null });
	for (const member of state.staff) {
		const actor = state.actors.find((a) => a.id === member.actorId);
		if (actor !== undefined) list.push({ key: member.key, kind: "employee", actor, member });
	}
	for (const actor of state.actors) if (actor.role === "machine") list.push({ key: `machine:${actor.id}`, kind: "machine", actor, member: null });
	if (state.chairman) list.push({ key: "chairman", kind: "chairman", actor: null, member: null });
	return list;
}

function wish(person: Person, layout: OfficeLayout, desks: readonly string[]): Wish {
	const actor = person.actor;
	if (person.kind === "chairman" || actor === null) return { room: "LOBBY", working: false, own: anchorOfKind(layout, "LOBBY", "chairman")?.id ?? null };
	if (actor.state === "awaiting") return { room: "SECURITY", working: true, own: null };
	const desk = person.member?.desk ?? null;
	const deskId = desk === null ? null : (desks[desk] ?? null);
	const directorChair = anchorOfKind(layout, "DIRECTOR", "director")?.id ?? null;
	if (actor.activity !== null) {
		let room = actor.activity.room;
		if (room === "WORK" && person.kind === "employee") room = homeRoomOf(actor.agentType);
		if (person.kind === "director" && room === "DIRECTOR") return { room, working: true, own: directorChair };
		return { room, working: true, own: room === "WORK" && person.kind === "employee" ? deskId : null };
	}
	if (person.kind === "machine") return { room: "SERVER", working: true, own: null };
	if (person.kind === "director") return { room: "DIRECTOR", working: false, own: directorChair };
	if (person.member?.nested === true || deskId === null) return { room: "MEETING", working: false, own: null };
	return { room: "WORK", working: false, own: deskId };
}

/** Everyone's place now, and the memory for the next call. Frozen while the power is out. */
export function officePlacement(
	state: OfficeState,
	layout: OfficeLayout,
	now: number,
	memory: PlacementMemory,
	size: ScreenSize = "desktop",
): { readonly placements: readonly Placement[]; readonly memory: PlacementMemory } {
	const desks = deskOrder(layout, size);
	const frozen = state.power === "out";
	const decided: { person: Person; room: RoomCode; keep: string | null; own: string | null; since: number; workedAt: number | null; busy: boolean }[] = [];
	for (const person of people(state)) {
		const want = wish(person, layout, desks);
		const was = memory.get(person.key);
		if (was === undefined) {
			decided.push({ person, room: want.room, keep: null, own: want.own, since: now, workedAt: want.working ? now : null, busy: want.working });
			continue;
		}
		const lingering = !want.working && was.workedAt !== null && now - was.workedAt < LINGER_MS;
		const held = frozen || (want.room !== was.room && (now - was.since < MIN_STAY_MS || lingering));
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
			});
		} else decided.push({ person, room: want.room, keep: null, own: want.own, since: now, workedAt: want.working ? now : null, busy: want.working });
	}
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
		};
	});
	return { placements, memory: next };
}
