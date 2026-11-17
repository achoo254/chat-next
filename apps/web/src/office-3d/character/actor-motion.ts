// Where a person is along a route at a moment: walking legs at a steady pace.
// Everyone moves on in this logic whether they are in the camera's view or
// not, so panning over finds them where the clock says. Pure, no engine.
import type { Leg, Route, RoutePoint } from "./office-routes.ts";

/** Walking pace, metres per second (a brisk office walk). */
export const WALK_SPEED = 1.6;
/**
 * The walking of one route takes at most this long: longer walks go faster,
 * so someone sent across the plan (the dorm to the shared work room is some
 * 35 m) gets there while the work is still on.
 */
export const MAX_WALK_SECONDS = 12;

export interface MotionSample {
	readonly x: number;
	readonly z: number;
	/** Babylon rotation.y of the way they face (0 looks to +z). */
	readonly heading: number;
	readonly moving: boolean;
	readonly done: boolean;
	/** Where a new route may start from without leaving the walkway (see `resumeSpot`). */
	readonly resume: { readonly x: number; readonly z: number; readonly node: string | null } | null;
}

function legLength(leg: Leg): number {
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

export function routeSeconds(route: Route): number {
	const pace = paceOf(route);
	return route.legs.reduce((sum, leg) => sum + legLength(leg) / pace, 0);
}

export function headingOf(dx: number, dz: number): number {
	return Math.atan2(dx, dz);
}

function lastPoint(route: Route): { point: RoutePoint; heading: number } | null {
	for (let i = route.legs.length - 1; i >= 0; i -= 1) {
		const leg = route.legs[i];
		const p = leg?.points[leg.points.length - 1];
		const q = leg?.points[leg.points.length - 2];
		if (p !== undefined) return { point: p, heading: q === undefined ? 0 : headingOf(p.x - q.x, p.z - q.z) };
	}
	return null;
}

/**
 * The person `elapsed` seconds into `route`. `fallback` is used for an empty
 * route (they stay put). After the end they stand at the last point.
 */
export function sampleRoute(route: Route, elapsed: number, fallback: { x: number; z: number; heading: number }): MotionSample {
	let t = Math.max(0, Number.isFinite(elapsed) ? elapsed : 0);
	const pace = paceOf(route);
	for (const leg of route.legs) {
		const seconds = legLength(leg) / pace;
		if (t >= seconds) {
			t -= seconds;
			continue;
		}
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
			return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, heading: headingOf(b.x - a.x, b.z - a.z), moving: true, done: false, resume };
		}
	}
	const end = lastPoint(route);
	if (end === null) return { ...fallback, moving: false, done: true, resume: null };
	return { x: end.point.x, z: end.point.z, heading: end.heading, moving: false, done: true, resume: null };
}
