// What the panel beside the office scene says at one moment (office-overview-panel.tsx):
// who is at work and on what, how many rest and how, and the session's counts the wall
// boards used to carry (to-do, checks, tokens and cost). Built from the frame's
// placements, the same ones the scene draws, so the panel never disagrees with the
// picture. Only people of the building count (the director, Advisor, the staff); a
// background service is a count of its own. Pure, no React.
import type { LifeAct } from "./office-life-schedule.ts";
import { markerView, personColor, personName, type MarkerStatus, type OfficeCopy } from "./office-names.ts";
import type { Placement } from "./office-placement.ts";
import type { RoomCode } from "./office-rooms.ts";

/** One person at work, as a line of the panel. */
export interface OverviewWorker {
	/** The placement key: opens the person's inspector. */
	readonly key: string;
	readonly name: string;
	readonly color: string;
	readonly status: MarkerStatus;
	/** The state in words when it says more than "at work" ("Kẹt 6 phút", "Chờ duyệt"); "" otherwise: colour alone never carries it. */
	readonly state: string;
	/** What they do ("Read · agent-core.ts", "Bash · git"); "" when nothing to say. */
	readonly doing: string;
	readonly room: RoomCode;
}

/** How many people spend their free time one way. */
export interface OverviewRest {
	readonly act: LifeAct;
	readonly count: number;
}

export interface OfficeOverview {
	/** The people of the building (not services). */
	readonly people: number;
	readonly working: readonly OverviewWorker[];
	readonly resting: readonly OverviewRest[];
	readonly restingCount: number;
	/** Free and at their seats, neither at work nor off duty on the living floor. */
	readonly atSeat: number;
}

/** Who is at work first (a stuck or waiting one before the rest), then by name, so the list does not shuffle. */
const STATUS_ORDER: Readonly<Record<MarkerStatus, number>> = { stuck: 0, awaiting: 1, denied: 2, slow: 3, working: 4, done: 5, idle: 6, "waiting-you": 7 };

export function officeOverview(placements: readonly Placement[], t: OfficeCopy): OfficeOverview {
	const people = placements.filter((p) => p.kind === "director" || p.kind === "employee" || p.kind === "advisor");
	const working: OverviewWorker[] = [];
	const rest = new Map<LifeAct, number>();
	let atSeat = 0;
	for (const p of people) {
		if (p.activityRoom !== null) {
			const view = markerView(t, p, null);
			working.push({ key: p.key, name: personName(t, p), color: personColor(p), status: view.status, state: view.status === "working" ? "" : view.label.slice(view.name.length).replace(/^ · /, ""), doing: view.bubble, room: p.activityRoom });
		} else if (p.life !== null) {
			rest.set(p.life.act, (rest.get(p.life.act) ?? 0) + 1);
		} else atSeat += 1;
	}
	working.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name));
	const resting = [...rest].map(([act, count]) => ({ act, count })).sort((a, b) => b.count - a.count || a.act.localeCompare(b.act));
	return { people: people.length, working, resting, restingCount: resting.reduce((n, r) => n + r.count, 0), atSeat };
}
