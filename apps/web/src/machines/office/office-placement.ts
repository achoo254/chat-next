// Where everyone in the office is: the room and the anchor they stand or
// sit at, from the store's state, the layout and the clock. Shared by the 2D
// and 3D views. Fifteen people are always in the building: the director, the
// advisor and the 13 staff of the studio (one per job title, whatever the
// agents are doing: office-cast.ts says which title an agent type is). Each
// title's person has a home seat (the layout's `home` anchors) in their home
// room and is shown busy only when real events say so: the subagent of their
// title (or, for the director's own tools, the department the tool belongs to)
// runs a tool. Several subagents of one title are the same person (with a
// count). A tool takes its person to the room it happens in and back after
// MIN_STAY_MS / LINGER_MS; a pending approval takes the person to Security and
// the Code & Security Reviewer greets at its door; asking Advisor takes the
// asker to Advisor's room. Rest, play and sleep (office-life-schedule.ts)
// happen only outside office hours and only while no agent runs; as soon as
// one runs everyone is at their seat again. Backend & DevOps never leaves the
// server room. The director sits at one seat, goes to a meeting, walks the
// desks to check (3D idle show), rests like the others, and only directs:
// the work of a tool belongs to its department; a subagent starting shows the
// director handing the job over. A background service the agent runs (a
// machine on the wire) is no person of its own: it is the work of the title
// that owns its kind (office-cast.ts serviceOwnerOf), done at their desk. The
// chairman waits in the lobby.
// Pure: the memory of the last call goes in, the new one comes out.
import {
	ALWAYS_ON_DUTY,
	serviceOwnerOf,
	STUDIO_TITLES,
	titleKeyOf,
	type CastKey,
	type StudioTitle,
} from "./office-cast.ts";
import { anchorById, anchorOfKind, spotsOf } from "./office-geometry.ts";
import type { LayoutAnchor, OfficeLayout } from "./office-layout.ts";
import { allocateLifePlaces } from "./office-life-places.ts";
import { lifeActAt, lifePlanAt, type LifeAct, type LifePlan, type LifeSlot } from "./office-life-schedule.ts";
import type { RoomCode } from "./office-rooms.ts";
import type { ServiceKind } from "./office-state.ts";
import type { ActivityView, ActorView, OfficeState, StaffMember } from "./office-store.ts";

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
/** The director hands a job over (a hand-in gesture) this long after a subagent really starts. */
export const DELEGATE_MS = 4_000;

export type PersonKind = "director" | "employee" | "chairman" | "advisor";

/** Who Advisor is to the viewer (their Advisor profile): its name and look. */
export interface OfficeAdvisor {
	readonly name: string;
	readonly lookId: string;
}

/** Advisor's room: it sits at the room's first meeting seat (the head of the table). */
export const ADVISOR_ROOM: RoomCode = "ADVISOR";

export interface Placement {
	/** "director", "advisor", "chairman", or "title:<castKey>" for a job title's person. */
	readonly key: string;
	readonly kind: PersonKind;
	/** The actor shown (null for the chairman and for an off-duty resident whose subagent left). */
	readonly actor: ActorView | null;
	/** The employee's staff entry (name, number, desk). */
	readonly member: StaffMember | null;
	readonly room: RoomCode;
	readonly anchorId: string;
	/** Viewer time the person entered this room. */
	readonly since: number;
	/** The room the person works in now; null when free (idle play may take them to the pantry or around their desk). */
	readonly activityRoom: RoomCode | null;
	/** Off duty at a place of the living rooms: the part of the day and what they do there; null otherwise. */
	readonly life: { readonly slot: LifeSlot; readonly act: LifeAct } | null;
	/** Advisor's name and look, from the viewer's Advisor profile; null for everyone else. */
	readonly advisor: OfficeAdvisor | null;
	/** How many subagents of the person's job title are at work at once (they are all this one person); 0 when none. */
	readonly concurrent: number;
	/** The key of the person's work log (state.work): the title's latest staff member's; the person's own key when none. */
	readonly workKey: string;
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
	readonly title: StudioTitle | null;
	readonly concurrent: number;
	readonly workKey: string;
}

interface Wish {
	readonly room: RoomCode;
	readonly working: boolean;
	/** An anchor that is the person's own there: a desk, the director's chair, the chairman's spot, a place of the living rooms. */
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

/** An actor is doing real work now (a tool is running, or its hand-in is still on). */
function working(a: ActorView): boolean {
	return a.activity !== null && a.state !== "done";
}

/** Whether any agent is running: the session is busy, or an actor (not a background service) is at work. */
export function agentRunning(state: OfficeState): boolean {
	return state.session.busy || state.actors.some((a) => a.role !== "machine" && a.role !== "advisor" && a.state === "working");
}

/** The tools of the director that are his own work: thinking and asking Advisor. Every other tool he runs belongs to a department. */
function directing(activity: Pick<ActivityView, "group">): boolean {
	return activity.group === "think" || activity.group === "consult";
}

/** The title whose department a room of the director's tool belongs to (none: nobody's, he does not do it). */
const DEPARTMENT: Readonly<Partial<Record<RoomCode, CastKey>>> = {
	WORK: "gameplayDeveloper",
	LIBRARY: "researchAnalyst",
	SERVER: "backendDevops",
	POST: "backendDevops",
	PLANNING: "producerPm",
	AUDIT: "codeSecurityReviewer",
	SECURITY: "codeSecurityReviewer",
	QA: "qaTester",
};

/**
 * The key of the person an actor's activity is shown on (the placement key the
 * inspector panel is opened with): the director's own work is his, any other
 * tool he runs is its department's person's (null when no department claims its
 * room: nobody does it and no bubble shows it), a subagent's is its job title's,
 * Advisor's is Advisor's, a background service's is the title that owns its kind.
 */
export function activityOwnerKey(
	actor: Pick<ActorView, "role" | "agentType"> & { readonly service: { readonly kind: ServiceKind } | null },
	activity: Pick<ActivityView, "group" | "room">,
): string | null {
	switch (actor.role) {
		case "director": {
			if (directing(activity)) return "director";
			const department = DEPARTMENT[activity.room];
			return department === undefined ? null : `title:${department}`;
		}
		case "advisor":
			return "advisor";
		case "machine":
			return `title:${serviceOwnerOf(actor.service?.kind)}`;
		case "employee":
			return `title:${titleKeyOf(actor.agentType)}`;
	}
}

/** The actor a title's person is shown as: the one at work (latest news first), else the latest heard of, else none. */
function pickActor(candidates: readonly ActorView[]): ActorView | null {
	const rank = (a: ActorView): number => (working(a) ? 2 : a.activity !== null ? 1 : 0);
	return [...candidates].sort((a, b) => rank(b) - rank(a) || b.heardAt - a.heardAt)[0] ?? null;
}

/** The director's tool done by the title's person: the director's actor as a member of the title's department. */
function delegated(director: ActorView, title: StudioTitle): ActorView {
	return { ...director, id: `${director.id}>${title.key}`, role: "employee", agentType: title.repType, parentId: director.id, spawnDepth: 1, state: "working" };
}

/**
 * A background service run by the title's person: the machine's actor as a member of the title, working at the person's
 * own desk (a tool in WORK is done in the title's home room). It keeps its service label, so the bubble and the inspector say what runs.
 */
function serviceWork(machine: ActorView, title: StudioTitle): ActorView {
	const activity: ActivityView | null = machine.activity === null ? null : { ...machine.activity, room: "WORK" };
	return { ...machine, role: "employee", agentType: title.repType, activity };
}

function people(state: OfficeState, now: number): Person[] {
	const list: Person[] = [];
	const director = state.actors.find((a) => a.role === "director") ?? null;
	// The director directs: his own tools are for his department's person; a subagent starting shows the hand-over.
	const starting = state.actors.find((a) => a.role === "employee" && a.state === "working" && a.enteredAt > 0 && now - (a.enteredAt + state.clockOffset) >= 0 && now - (a.enteredAt + state.clockOffset) < DELEGATE_MS);
	const doing = director !== null && director.state !== "done" ? director.activity : null;
	const handOver: ActivityView | null =
		starting === undefined ? null : { id: `delegate:${starting.id}`, tool: "", group: "hand-in", room: "DIRECTOR", subject: "", startedAt: starting.enteredAt, slow: false, stuckMs: null };
	const own = doing !== null && directing(doing) ? doing : handOver;
	list.push({ key: "director", kind: "director", actor: director === null ? null : { ...director, activity: own }, member: null, title: null, concurrent: 0, workKey: "director" });
	const advisor = state.actors.find((a) => a.role === "advisor") ?? null;
	list.push({ key: "advisor", kind: "advisor", actor: advisor, member: null, title: null, concurrent: 0, workKey: "advisor" });
	const employees = state.actors.filter((a) => a.role === "employee");
	const department = doing !== null && !directing(doing) ? DEPARTMENT[doing.room] : undefined;
	// Background services at work; one that is not (no activity) has nothing to show.
	const services = state.actors.filter((a) => a.role === "machine" && working(a));
	for (const title of STUDIO_TITLES) {
		const mine = employees.filter((a) => titleKeyOf(a.agentType) === title.key);
		const extra = director !== null && department === title.key ? [delegated(director, title)] : [];
		const runs = services.filter((a) => serviceOwnerOf(a.service?.kind) === title.key).map((a) => serviceWork(a, title));
		const actor = pickActor([...mine, ...extra, ...runs]);
		const members = state.staff.filter((m) => titleKeyOf(m.agentType) === title.key).sort((a, b) => b.firstEnteredAt - a.firstEnteredAt);
		const key = `title:${title.key}`;
		// A person of the title has their own seat and never waits for a desk or comes in through the lobby: `nested` keeps them out of the meeting room's "+N".
		const member: StaffMember = { key, agentType: title.repType, ordinal: 1, actorId: actor?.id ?? "", desk: null, nested: true, firstEnteredAt: 0 };
		list.push({ key, kind: "employee", actor, member, title, concurrent: mine.filter(working).length, workKey: members[0]?.key ?? key });
	}
	if (state.chairman) list.push({ key: "chairman", kind: "chairman", actor: null, member: null, title: null, concurrent: 0, workKey: "chairman" });
	return list;
}

/** What the person does now: a finished employee's hand-in only for its visit. */
export function currentActivity(actor: ActorView, now: number, clockOffset: number): ActorView["activity"] {
	const a = actor.activity;
	if (a !== null && actor.state === "done" && a.group === "hand-in" && now - (a.startedAt + clockOffset) >= HAND_IN_MS) return null;
	return a;
}

/** A plan that sends the person to the living rooms (outside office hours), or null. */
function livingPlan(key: string, now: number): LifePlan | null {
	const plan = lifePlanAt(key, now);
	return plan.kinds.length === 0 ? null : plan;
}

/** The anchor that is `homeKey`'s own seat in the layout (the `home` of the anchor), or null. */
function homeSeat(layout: OfficeLayout, homeKey: string): string | null {
	return layout.anchors.find((a) => a.home === homeKey)?.id ?? null;
}

function wish(person: Person, layout: OfficeLayout, state: OfficeState, now: number, running: boolean): Wish {
	const actor = person.actor;
	if (person.kind === "chairman") return { room: "LOBBY", working: false, own: anchorOfKind(layout, "LOBBY", "chairman")?.id ?? null, life: null };
	const advisorSeat = anchorOfKind(layout, ADVISOR_ROOM, "meeting")?.id ?? null;
	// Advisor never leaves its seat day or night; it counts as busy only while someone really asks it.
	if (person.kind === "advisor") {
		const asked = state.actors.some((a) => a.role !== "advisor" && a.state !== "done" && a.activity?.group === "consult");
		return { room: ADVISOR_ROOM, working: asked, own: advisorSeat, life: null };
	}
	// Rest, play and sleep only off office hours and only while no agent runs: otherwise everyone is at their seat.
	const rests = (): LifePlan | null => (running ? null : livingPlan(person.key, now));
	const activity = actor === null ? null : currentActivity(actor, now, state.clockOffset);
	if (person.kind === "director") {
		const chair = anchorOfKind(layout, "DIRECTOR", "director")?.id ?? null;
		// Asking Advisor: the director goes there; thinking and the hand-over stay at his chair.
		if (activity !== null && activity.group === "consult") return { room: ADVISOR_ROOM, working: true, own: advisorSeat, life: null };
		if (activity !== null) return { room: "DIRECTOR", working: true, own: chair, life: null };
		return { room: "DIRECTOR", working: false, own: chair, life: rests() };
	}
	const title = person.title;
	if (title === null) return { room: "WORK", working: false, own: null, life: null };
	const seat = homeSeat(layout, title.homeKey);
	// Backend & DevOps is always on duty in the server room.
	if (title.key === ALWAYS_ON_DUTY) return { room: "SERVER", working: activity !== null, own: seat, life: null };
	// Someone waits for an approval: the reviewer greets at the door of Security (the anchor that greets for their title).
	if (title.key === "codeSecurityReviewer" && state.actors.some((a) => a.state === "awaiting" && a.role !== "machine")) {
		return { room: "SECURITY", working: true, own: layout.anchors.find((a) => a.greets === title.homeKey)?.id ?? null, life: null };
	}
	if (actor !== null && actor.state === "awaiting") return { room: "SECURITY", working: true, own: null, life: null };
	if (activity !== null) {
		// Asking Advisor: beside its seat. A tool in WORK is done at the title's home room; any other room is visited.
		if (activity.group === "consult") return { room: ADVISOR_ROOM, working: true, own: advisorSeat, life: null };
		const room = activity.room === "WORK" ? title.homeRoom : activity.room;
		return { room, working: true, own: room === title.homeRoom ? seat : null, life: null };
	}
	return { room: title.homeRoom, working: false, own: seat, life: rests() };
}

/** Everyone's wish, with the living rooms' places allocated: the room and own place of whoever follows the schedule now. */
function wishes(list: readonly Person[], layout: OfficeLayout, state: OfficeState, now: number, memory: PlacementMemory): Wish[] {
	const running = agentRunning(state);
	const raw = list.map((person) => wish(person, layout, state, now, running));
	const seekers = list.flatMap((person, i) => {
		const plan = raw[i]?.life ?? null;
		return plan === null ? [] : [{ key: person.key, plan, had: memory.get(person.key)?.anchorId ?? null }];
	});
	const places = allocateLifePlaces(layout, seekers, new Set());
	return raw.map((w, i) => {
		const place: LayoutAnchor | undefined = places.get(list[i]?.key ?? "");
		if (w.life === null) return w;
		// A layout without living places: the work rooms, as in office hours.
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
	advisor: OfficeAdvisor | null = null,
): { readonly placements: readonly Placement[]; readonly memory: PlacementMemory } {
	// Before the first snapshot nobody is placed (the fifteen would otherwise be held in their seats when the first events come).
	if (state.status === "loading") return { placements: [], memory: EMPTY_MEMORY };
	const frozen = state.power === "out";
	const decided: Decision[] = [];
	const everyone = people(state, now);
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
			room: d.room,
			anchorId,
			since: d.since,
			activityRoom: d.busy ? d.room : null,
			life: d.life === null || place === undefined ? null : { slot: d.life.slot, act: lifeActAt(place, d.life.slot, d.person.key, now) },
			// Advisor is who the viewer's profile says (the machine belongs to the viewer's account): no profile, the defaults.
			advisor: d.person.kind === "advisor" ? (advisor ?? { name: "", lookId: "" }) : null,
			concurrent: d.person.concurrent,
			workKey: d.person.workKey,
		};
	});
	return { placements, memory: next };
}
