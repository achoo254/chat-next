// [T1][T2][T3][T4] over the office, shared by the 2D and 3D views (the 3D scene
// gets the floor as a prop). A dot marks a floor where someone works. Follow
// mode (on by default, kept on this device) moves to the floor where an
// activity just began (or, with nobody working, to where most people are), at most once per FLOOR_HOLD_MS, and pauses for
// USER_PAUSE_MS after the user picks a floor: a session typically uses all
// three floors, and without following one would only ever see the first.
// nextFloor is the decision, pure for tests.
import { FLOOR_LEVELS, type FloorLevel } from "./office-rooms.ts";
import type { Placement } from "./office-placement.ts";
import { useMachinesCopy } from "../use-machines-copy.ts";

/** Following stays at least this long on a floor. */
export const FLOOR_HOLD_MS = 6_000;
/** A floor the user picked holds following back this long. */
export const USER_PAUSE_MS = 30_000;

const FOLLOW_KEY = "ai:office:follow";

export interface FollowState {
	readonly floor: FloorLevel;
	/** Viewer time of the last change of floor (0: never). */
	readonly switchedAt: number;
	/** Viewer time the user last picked a floor; null if never. */
	readonly pickedAt: number | null;
}

export const FIRST_FLOOR: FollowState = { floor: 1, switchedAt: 0, pickedAt: null };

/** The newest work that began anywhere: the floor to follow to. */
export function latestWork(placements: readonly Placement[]): { readonly floor: FloorLevel; readonly since: number } | null {
	let latest: { floor: FloorLevel; since: number } | null = null;
	for (const p of placements) {
		if (p.kind === "chairman" || p.activityRoom === null) continue;
		if (latest === null || p.since > latest.since) latest = { floor: p.floor, since: p.since };
	}
	return latest;
}

/**
 * Where following goes: the newest work; with nobody working, the floor where
 * most people are (the living floor at night), as of the latest arrival
 * there, so following moves once when people settle somewhere else.
 */
export function followTarget(placements: readonly Placement[]): { readonly floor: FloorLevel; readonly since: number } | null {
	const work = latestWork(placements);
	if (work !== null) return work;
	const crowd = new Map<FloorLevel, { count: number; since: number }>();
	for (const p of placements) {
		if (p.kind === "chairman") continue;
		const c = crowd.get(p.floor) ?? { count: 0, since: 0 };
		crowd.set(p.floor, { count: c.count + 1, since: Math.max(c.since, p.since) });
	}
	let best: { floor: FloorLevel; count: number; since: number } | null = null;
	for (const [floor, c] of crowd) if (best === null || c.count > best.count || (c.count === best.count && floor < best.floor)) best = { floor, ...c };
	return best === null ? null : { floor: best.floor, since: best.since };
}

/** Floors where someone works now (the dots). */
export function busyFloors(placements: readonly Placement[]): ReadonlySet<FloorLevel> {
	return new Set(placements.filter((p) => p.kind !== "chairman" && p.activityRoom !== null).map((p) => p.floor));
}

export function nextFloor(state: FollowState, input: { readonly follow: boolean; readonly now: number; readonly latest: { readonly floor: FloorLevel; readonly since: number } | null }): FollowState {
	const { follow, now, latest } = input;
	// The viewer's clock was set back: what happened "later" than now is forgotten.
	if (now < state.switchedAt || (state.pickedAt !== null && now < state.pickedAt)) return nextFloor({ floor: state.floor, switchedAt: 0, pickedAt: null }, input);
	if (!follow || latest === null || latest.floor === state.floor) return state;
	if (latest.since <= state.switchedAt) return state;
	if (state.switchedAt > 0 && now - state.switchedAt < FLOOR_HOLD_MS) return state;
	if (state.pickedAt !== null && now - state.pickedAt < USER_PAUSE_MS) return state;
	return { ...state, floor: latest.floor, switchedAt: now };
}

/** The user picked `floor`. */
export function pickFloor(floor: FloorLevel, now: number): FollowState {
	return { floor, switchedAt: now, pickedAt: now };
}

export function followPreference(): boolean {
	try {
		return window.localStorage.getItem(FOLLOW_KEY) !== "off";
	} catch {
		return true;
	}
}

export function rememberFollow(on: boolean): void {
	try {
		window.localStorage.setItem(FOLLOW_KEY, on ? "on" : "off");
	} catch {
		// Storage refused: the choice holds for this page.
	}
}

export function OfficeFloorTabs({
	floor,
	busy,
	follow,
	onPick,
	onFollow,
}: {
	floor: FloorLevel;
	busy: ReadonlySet<FloorLevel>;
	follow: boolean;
	onPick: (floor: FloorLevel) => void;
	onFollow: (on: boolean) => void;
}) {
	const t = useMachinesCopy().office;
	return (
		<div className="of-floors" data-id="office-floors">
			<div className="mx-view-switch of-floor-switch" role="group" aria-label={t.floorsLabel}>
				{FLOOR_LEVELS.map((level) => (
					<button
						key={level}
						type="button"
						aria-pressed={floor === level}
						aria-label={busy.has(level) ? t.floorBusy(t.floors[level]) : t.floors[level]}
						title={t.floorNames[level]}
						onClick={() => onPick(level)}
						data-id={`office-floor-${level}`}
					>
						<span>{t.floors[level]}</span>
						{busy.has(level) && <span className="of-floor-dot" aria-hidden="true" />}
					</button>
				))}
			</div>
			<button type="button" className="of-toggle" aria-pressed={follow} onClick={() => onFollow(!follow)} title={t.followHint} data-id="office-follow">
				{t.follow}
			</button>
		</div>
	);
}
