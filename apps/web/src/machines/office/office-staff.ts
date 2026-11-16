// The office's employees, one per agent type at a time: the agent sends each
// subagent as its own actor, the office folds them into people. A new
// subagent of a type whose employee has finished is that same employee back
// at work; only when every employee of the type is busy does someone new
// come in, named with a number ("Tí Trinh Sát 2"). Each employee keeps one
// home desk for the whole session; with no desk left they sit in the meeting
// room and take the first desk that frees up. Employees of a nested subagent
// or a workflow work from the meeting room and never take a desk. An
// employee whose subagent left does not go home: they stay as an off-duty
// resident (no desk) and live by the daily schedule; the next subagent of
// their type brings that same person back to work. Pure: the store calls
// these on every change.

export interface StaffMember {
	/** Stable while the employee stays: "<agent type>#<ordinal>" (nested ones carry a "~"). */
	readonly key: string;
	readonly agentType: string;
	/** 1 for the first employee of the type, 2 for the next one busy at the same time, … */
	readonly ordinal: number;
	/** The actor (subagent) the employee works as now. */
	readonly actorId: string;
	/** The home desk's anchor id ("desk-3"); null in the meeting room. */
	readonly desk: string | null;
	/** A nested subagent or a workflow's agent: the meeting room, never a desk. */
	readonly nested: boolean;
	/** When this employee first came in (machine time). */
	readonly firstEnteredAt: number;
}

export interface Hire {
	readonly actorId: string;
	readonly agentType: string;
	readonly nested: boolean;
	readonly enteredAt: number;
}

/** Whether the employee's current actor has finished by `at` (machine time): such an employee takes the next subagent of the type. */
export type FreeAt = (actorId: string, at: number) => boolean;

function keyOf(agentType: string, nested: boolean, ordinal: number): string {
	return `${nested ? "~" : ""}${agentType}#${ordinal}`;
}

/**
 * Seats people at `desks` (anchor ids, in the order they are taken): a desk
 * not offered any more (a phone uses six of the eight) is given up, free ones
 * go to the people waiting in the meeting room, longest waiting first. Nobody
 * keeping a desk moves, so turning a phone keeps everyone where they sat.
 */
export function fillDesks(staff: readonly StaffMember[], desks: readonly string[]): StaffMember[] {
	const taken = new Set<string>();
	const kept = staff.map((m) => {
		if (m.desk === null || !desks.includes(m.desk) || taken.has(m.desk)) return m.desk === null ? m : { ...m, desk: null };
		taken.add(m.desk);
		return m;
	});
	return kept.map((m) => {
		if (m.nested || m.desk !== null) return m;
		const desk = desks.find((d) => !taken.has(d));
		if (desk === undefined) return m;
		taken.add(desk);
		return { ...m, desk };
	});
}

/** The same people seen again (a fresh snapshot): each employee sits back at the desk they had, by key; the rest are seated as usual. */
export function reseat(staff: readonly StaffMember[], before: readonly StaffMember[], desks: readonly string[]): StaffMember[] {
	const had = new Map(before.map((m) => [m.key, m.desk]));
	// Those who had a desk claim it first; fillDesks then seats the rest in order.
	return fillDesks(
		staff.map((m) => ({ ...m, desk: m.nested ? null : (had.get(m.key) ?? null) })),
		desks,
	);
}

/**
 * A subagent came in: the free employee of its type takes it, else an
 * off-duty resident of the type comes back to work (`offDuty`; the caller
 * drops them from its list), else a new employee does.
 */
export function hire(staff: readonly StaffMember[], next: Hire, freeAt: FreeAt, desks: readonly string[], offDuty: readonly StaffMember[] = []): StaffMember[] {
	if (staff.some((m) => m.actorId === next.actorId)) return [...staff];
	const sameType = (m: StaffMember): boolean => m.agentType === next.agentType && m.nested === next.nested;
	const same = staff.filter(sameType);
	const free = same.filter((m) => freeAt(m.actorId, next.enteredAt)).sort((a, b) => a.ordinal - b.ordinal)[0];
	if (free !== undefined) return staff.map((m) => (m === free ? { ...m, actorId: next.actorId } : m));
	const resting = offDuty.filter((m) => sameType(m) && !staff.some((s) => s.key === m.key)).sort((a, b) => a.ordinal - b.ordinal)[0];
	if (resting !== undefined) return fillDesks([...staff, { ...resting, actorId: next.actorId, desk: null }], desks);
	const used = new Set([...same, ...offDuty.filter(sameType)].map((m) => m.ordinal));
	let ordinal = 1;
	while (used.has(ordinal)) ordinal++;
	const member: StaffMember = {
		key: keyOf(next.agentType, next.nested, ordinal),
		agentType: next.agentType,
		ordinal,
		actorId: next.actorId,
		desk: null,
		nested: next.nested,
		firstEnteredAt: next.enteredAt,
	};
	return fillDesks([...staff, member], desks);
}

/** The actor left: its employee goes home (an employee who moved on to another subagent stays). */
export function release(staff: readonly StaffMember[], actorId: string, desks: readonly string[]): StaffMember[] {
	if (!staff.some((m) => m.actorId === actorId)) return [...staff];
	return fillDesks(
		staff.filter((m) => m.actorId !== actorId),
		desks,
	);
}

/** The actor left: its employee goes off duty and stays in the building as a resident (desk given up); another employee keeps working. */
export function retire(
	staff: readonly StaffMember[],
	offDuty: readonly StaffMember[],
	actorId: string,
	desks: readonly string[],
): { readonly staff: StaffMember[]; readonly offDuty: StaffMember[] } {
	const leaving = staff.find((m) => m.actorId === actorId);
	if (leaving === undefined) return { staff: [...staff], offDuty: [...offDuty] };
	return { staff: release(staff, actorId, desks), offDuty: [...offDuty.filter((m) => m.key !== leaving.key), { ...leaving, desk: null }] };
}

/** People waiting for a desk in the meeting room ("+N"); nested employees are not waiting for one. */
export function overflowOf(staff: readonly StaffMember[]): number {
	return staff.filter((m) => !m.nested && m.desk === null).length;
}
