// The geometry of a road (a trace from the model to a module): one sampled
// track with rounded corners, which the road's body, the packets that travel
// it and its red stretch of failures all follow, so they can never drift apart.
// The scene table keeps the hand-set corners of each route; `roundCorners`
// turns them into the track. Pure: no drawing, no state.
import type { Point } from "./scene-table.ts";

/** How far from a corner the track starts to turn, in scene pixels. */
export const CORNER_RADIUS = 24;
/** Points sampled along each rounded corner. */
export const CORNER_STEPS = 7;
/** A share of failures is drawn at least this long, so one failure among many calls is still seen. */
export const MIN_FAILURE_PX = 16;

const legLength = (a: Point, b: Point): number => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** The length of a path of straight legs. */
export function pathLength(path: readonly Point[]): number {
	let total = 0;
	for (let i = 1; i < path.length; i++) total += legLength(path[i - 1] ?? [0, 0], path[i] ?? [0, 0]);
	return total;
}

/**
 * The route with every inner corner rounded by a quadratic curve, sampled into
 * short straight legs. A corner never takes more than 42% of either leg, so
 * two corners on a short leg do not meet. A route of fewer than three points
 * has no corner and is returned as it is.
 */
export function roundCorners(route: readonly Point[], radius = CORNER_RADIUS, steps = CORNER_STEPS): readonly Point[] {
	if (route.length < 3) return route.map(([x, y]): Point => [x, y]);
	const first = route[0] ?? [0, 0];
	const out: Point[] = [[first[0], first[1]]];
	for (let i = 1; i < route.length - 1; i++) {
		const a = route[i - 1] ?? first;
		const b = route[i] ?? a;
		const c = route[i + 1] ?? b;
		const la = legLength(a, b);
		const lc = legLength(b, c);
		const r = Math.min(radius, la * 0.42, lc * 0.42);
		if (r <= 0 || la === 0 || lc === 0) {
			out.push([b[0], b[1]]);
			continue;
		}
		const start: Point = [b[0] + ((a[0] - b[0]) * r) / la, b[1] + ((a[1] - b[1]) * r) / la];
		const end: Point = [b[0] + ((c[0] - b[0]) * r) / lc, b[1] + ((c[1] - b[1]) * r) / lc];
		out.push(start);
		for (let j = 1; j <= steps; j++) {
			const t = j / steps;
			const u = 1 - t;
			out.push([u * u * start[0] + 2 * u * t * b[0] + t * t * end[0], u * u * start[1] + 2 * u * t * b[1] + t * t * end[1]]);
		}
	}
	const last = route[route.length - 1] ?? first;
	out.push([last[0], last[1]]);
	return out;
}

/** The point at `t` (0 to 1) along a path of straight legs, by length. */
export function pathPoint(path: readonly Point[], t: number): Point {
	const first = path[0];
	if (first === undefined) return [0, 0];
	if (path.length === 1 || t <= 0) return first;
	const total = pathLength(path);
	if (total === 0) return first;
	let left = Math.min(1, t) * total;
	for (let i = 1; i < path.length; i++) {
		const a = path[i - 1] ?? first;
		const b = path[i] ?? a;
		const len = legLength(a, b);
		if (left <= len || i === path.length - 1) {
			const f = len === 0 ? 1 : Math.min(1, left / len);
			return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
		}
		left -= len;
	}
	return path[path.length - 1] ?? first;
}

/** The part of a path between `from` and `to` (0 to 1, by length), with the exact points at both ends. */
export function pathSlice(path: readonly Point[], from: number, to: number): readonly Point[] {
	const lo = Math.max(0, Math.min(1, from));
	const hi = Math.max(lo, Math.min(1, to));
	const total = pathLength(path);
	const out: Point[] = [pathPoint(path, lo)];
	let walked = 0;
	for (let i = 1; i < path.length; i++) {
		const a = path[i - 1] ?? [0, 0];
		const b = path[i] ?? a;
		walked += legLength(a, b);
		// A vertex strictly inside the slice belongs to it.
		if (walked > lo * total && walked < hi * total) out.push([b[0], b[1]]);
	}
	out.push(pathPoint(path, hi));
	return out;
}

/** The width of a road's body: it grows with the calls that ended on it, on a log scale so a hundred calls do not drown ten. */
export function roadWidth(calls: number): number {
	return 1.5 + Math.min(8.5, Math.log2(1 + Math.max(0, calls)) * 1.75);
}

/** The share of a road (0 to 1) drawn red: its failure rate, but never shorter than MIN_FAILURE_PX once a call has failed; 0 with none. */
export function failureShare(failures: number, calls: number, length: number): number {
	if (failures <= 0 || calls <= 0 || length <= 0) return 0;
	return Math.min(1, Math.max(failures / calls, MIN_FAILURE_PX / length));
}
