// Where a person is along a route at a moment: walking legs at a steady pace,
// elevator legs for their travel time (out of sight inside). Everyone moves on
// in this logic whether their floor is shown or not, so switching floors
// finds them where the clock says. Pure, no engine.
import type { FloorLevel } from "../../machines/office/office-rooms.ts";
import type { Leg, Route, RoutePoint } from "./office-routes.ts";

/** Walking pace, metres per second (a brisk office walk). */
export const WALK_SPEED = 1.6;
/**
 * The walking of one route takes at most this long (elevator rides apart):
 * longer walks go faster, so someone sent to another floor gets there while
 * the work is still on (tools are short; following moves the camera at once).
 */
export const MAX_WALK_SECONDS = 7;

export interface MotionSample {
	readonly floor: FloorLevel;
	readonly x: number;
	readonly z: number;
	/** Babylon rotation.y of the way they face (0 looks to +z). */
	readonly heading: number;
	readonly moving: boolean;
	/** Inside the elevator: drawn nowhere. */
	readonly inLift: boolean;
	readonly done: boolean;
	/** Where a new route may start from without leaving the walkway (see `resumeSpot`). */
	readonly resume: { readonly x: number; readonly z: number; readonly node: string | null } | null;
}

function legLength(leg: Leg): number {
	if (leg.kind === "lift") return 0;
	let length = 0;
	for (let i = 1; i < leg.points.length; i += 1) {
		const a = leg.points[i - 1];
		const b = leg.points[i];
		if (a !== undefined && b !== undefined) length += Math.hypot(b.x - a.x, b.z - a.z);
	}
	return length;
}

/** Metres per second for a route: the normal pace, or faster to keep its walking under MAX_WALK_SECONDS. */
export function paceOf(route: Route): number {
	const walked = route.legs.reduce((sum, leg) => sum + legLength(leg), 0);
	return Math.max(WALK_SPEED, walked / MAX_WALK_SECONDS);
}

function legSeconds(leg: Leg, pace: number): number {
	return leg.kind === "lift" ? leg.seconds : legLength(leg) / pace;
}

export function routeSeconds(route: Route): number {
	const pace = paceOf(route);
	return route.legs.reduce((sum, leg) => sum + legSeconds(leg, pace), 0);
}

export function headingOf(dx: number, dz: number): number {
	return Math.atan2(dx, dz);
}

function lastPoint(route: Route): { floor: FloorLevel; point: RoutePoint; heading: number } | null {
	for (let i = route.legs.length - 1; i >= 0; i -= 1) {
		const leg = route.legs[i];
		if (leg === undefined) continue;
		if (leg.kind === "lift") return { floor: leg.to, point: { x: leg.x, z: leg.z, node: null }, heading: 0 };
		const p = leg.points[leg.points.length - 1];
		const q = leg.points[leg.points.length - 2];
		if (p !== undefined) return { floor: leg.floor, point: p, heading: q === undefined ? 0 : headingOf(p.x - q.x, p.z - q.z) };
	}
	return null;
}

/**
 * The person `elapsed` seconds into `route`. `fallback` is used for an empty
 * route (they stay put). After the end they stand at the last point.
 */
export function sampleRoute(route: Route, elapsed: number, fallback: { floor: FloorLevel; x: number; z: number; heading: number }): MotionSample {
	let t = Math.max(0, Number.isFinite(elapsed) ? elapsed : 0);
	const pace = paceOf(route);
	for (const leg of route.legs) {
		const seconds = legSeconds(leg, pace);
		if (t >= seconds) {
			t -= seconds;
			continue;
		}
		if (leg.kind === "lift") return { floor: leg.to, x: leg.x, z: leg.z, heading: 0, moving: false, inLift: true, done: false, resume: null };
		let along = t * pace;
		for (let i = 1; i < leg.points.length; i += 1) {
			const a = leg.points[i - 1];
			const b = leg.points[i];
			if (a === undefined || b === undefined) continue;
			const length = Math.hypot(b.x - a.x, b.z - a.z);
			if (along > length) {
				along -= length;
				continue;
			}
			const f = length > 0 ? along / length : 1;
			// A new route goes back to this segment's node or on to its next one, staying on the walkway.
			const resume = b.node !== null ? b : a;
			return { floor: leg.floor, x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, heading: headingOf(b.x - a.x, b.z - a.z), moving: true, inLift: false, done: false, resume };
		}
	}
	const end = lastPoint(route);
	if (end === null) return { ...fallback, moving: false, inLift: false, done: true, resume: null };
	return { floor: end.floor, x: end.point.x, z: end.point.z, heading: end.heading, moving: false, inLift: false, done: true, resume: null };
}
