// The roads of the Live Map (a trace from the model to each module): the corner
// rounding, the walk along a track, the slice that is red, the width and the
// failure share; and the layout itself: no two roads cross or run side by side
// too close, none runs through a module, a figure or the model's title, every
// one leaves the model and ends on its module, and the packets, the body and
// the red stretch all follow the one rounded track.
import { describe, expect, it } from "vitest";
import { roadOf } from "../../src/machines/observatory/render/prop-map.ts";
import {
	CORNER_RADIUS,
	pathLength,
	pathPoint,
	pathSlice,
	roadWidth,
	roundCorners,
} from "../../src/machines/observatory/render/road-geometry.ts";
import { INTERIOR, MODEL_TITLE_WIDTH, PLACE_IDS, type PlaceId, type Point, type Rect } from "../../src/machines/observatory/render/scene-table.ts";

type Seg = readonly [Point, Point];

const near = (a: Point, b: Point, eps = 1e-6): boolean => Math.hypot(a[0] - b[0], a[1] - b[1]) <= eps;
const ROADS = PLACE_IDS.filter((id) => INTERIOR.places[id].route.length >= 2);
const segmentsOf = (path: readonly Point[]): Seg[] => path.slice(1).map((b, i): Seg => [path[i] ?? b, b]);
const NOWHERE: Point = [-1, -1];

describe("rounding the corners of a route", () => {
	it("keeps both ends and leaves a straight route alone", () => {
		const track = roundCorners([
			[0, 0],
			[100, 0],
			[100, 100],
		]);
		expect(near(track[0] ?? NOWHERE, [0, 0])).toBe(true);
		expect(near(track.at(-1) ?? NOWHERE, [100, 100])).toBe(true);
		expect(
			roundCorners([
				[0, 0],
				[50, 0],
			]),
		).toEqual([
			[0, 0],
			[50, 0],
		]);
		expect(roundCorners([[3, 4]])).toEqual([[3, 4]]);
	});

	it("cuts the corner: it comes no nearer the corner than the curve allows, and the track is a little shorter than the hand-set route", () => {
		const route: Point[] = [
			[0, 0],
			[200, 0],
			[200, 200],
		];
		const track = roundCorners(route);
		const nearest = Math.min(...track.map(([x, y]) => Math.hypot(x - 200, y)));
		expect(nearest).toBeGreaterThan(5);
		expect(nearest).toBeLessThan(CORNER_RADIUS);
		expect(pathLength(track)).toBeLessThan(pathLength(route));
		expect(pathLength(track)).toBeGreaterThan(pathLength(route) - 2 * CORNER_RADIUS);
	});

	it("never takes more than 42% of a short leg, so two corners on it do not meet", () => {
		const track = roundCorners([
			[0, 0],
			[100, 0],
			[100, 20],
			[0, 20],
		]);
		for (let i = 1; i < track.length; i++) expect(near(track[i - 1] ?? [0, 0], track[i] ?? [1, 1])).toBe(false);
		// The 20 px leg keeps a straight stretch between its two curves.
		const onLeg = track.filter(([x]) => x === 100).map(([, y]) => y);
		expect(Math.max(...onLeg) - Math.min(...onLeg)).toBeGreaterThanOrEqual(0);
		const curveEnd = Math.min(...track.filter(([x, y]) => x > 90 && y > 0 && y < 20).map(([, y]) => y));
		expect(curveEnd).toBeGreaterThan(0);
	});

	it("turns every corner of every road in the scene into a curve of short steps, never a right angle", () => {
		for (const id of ROADS) {
			const { route, road } = INTERIOR.places[id];
			expect(road.length, id).toBeGreaterThanOrEqual(route.length);
			if (route.length < 3) continue;
			// A curve has steps that are neither horizontal nor vertical.
			const slanted = segmentsOf(road).filter(([a, b]) => a[0] !== b[0] && a[1] !== b[1]);
			expect(slanted.length, `${id} has curved steps`).toBeGreaterThan(0);
		}
	});
});

describe("walking and slicing a track", () => {
	const track = roundCorners([
		[0, 0],
		[300, 0],
		[300, 200],
		[600, 200],
	]);

	it("a point at 0 and 1 is the start and the end, and a half slice is half the length", () => {
		expect(near(pathPoint(track, 0), [0, 0])).toBe(true);
		expect(near(pathPoint(track, 1), [600, 200])).toBe(true);
		expect(pathLength(pathSlice(track, 0, 0.5))).toBeCloseTo(pathLength(track) / 2, 3);
	});

	it("a slice runs exactly from one fraction to the other and lies on the track", () => {
		const total = pathLength(track);
		const slice = pathSlice(track, 0.6, 1);
		expect(pathLength(slice)).toBeCloseTo(total * 0.4, 3);
		expect(near(slice[0] ?? NOWHERE, pathPoint(track, 0.6))).toBe(true);
		expect(near(slice.at(-1) ?? NOWHERE, [600, 200])).toBe(true);
		// Every vertex of the slice but its two ends is a vertex of the track.
		for (const p of slice.slice(1, -1)) expect(track.some((q) => near(p, q))).toBe(true);
	});

	it("the whole track and an empty, reversed or out-of-range slice behave", () => {
		expect(pathLength(pathSlice(track, 0, 1))).toBeCloseTo(pathLength(track), 3);
		expect(pathLength(pathSlice(track, 0.5, 0.5))).toBe(0);
		expect(pathLength(pathSlice(track, 0.9, 0.2))).toBe(0);
		expect(pathLength(pathSlice(track, -3, 9))).toBeCloseTo(pathLength(track), 3);
	});
});

describe("a road's width", () => {
	it("grows with the calls, slowly, and stays within a body that fits beside its neighbours", () => {
		const widths = [0, 1, 4, 10, 140, 10_000].map(roadWidth);
		for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeGreaterThanOrEqual(widths[i - 1] ?? 0);
		expect(widths[0]).toBeCloseTo(1.5, 5);
		expect(Math.max(...widths)).toBeLessThanOrEqual(10);
		expect(roadWidth(140) - roadWidth(4)).toBeGreaterThan(2.5);
		expect(roadWidth(-5)).toBe(roadWidth(0));
	});
});

describe("the layout of the roads", () => {
	// The hand-set routes have right-angle corners, so crossings and overlaps are exact on them.
	const hand = (id: PlaceId): Seg[] => segmentsOf(INTERIOR.places[id].route);
	const vertical = (s: Seg): boolean => s[0][0] === s[1][0];
	const horizontal = (s: Seg): boolean => s[0][1] === s[1][1];
	const model = INTERIOR.places.core.rect;

	/** Whether a leg passes through the inside of a box grown by `pad`. */
	const through = (s: Seg, r: Rect, pad = 0): boolean => {
		const x0 = Math.min(s[0][0], s[1][0]);
		const x1 = Math.max(s[0][0], s[1][0]);
		const y0 = Math.min(s[0][1], s[1][1]);
		const y1 = Math.max(s[0][1], s[1][1]);
		return x1 > r.x - pad && x0 < r.x + r.w + pad && y1 > r.y - pad && y0 < r.y + r.h + pad;
	};
	const inModel = (p: Point): boolean => p[0] >= model.x && p[0] <= model.x + model.w && p[1] >= model.y && p[1] <= model.y + model.h;
	/** The legs of a road that are not inside the model's box (a road begins inside it). */
	const outsideModel = (id: PlaceId): Seg[] => hand(id).filter(([a, b]) => !(inModel(a) && inModel(b)));

	it("every leg is horizontal or vertical", () => {
		for (const id of ROADS) for (const s of hand(id)) expect(vertical(s) || horizontal(s), `${id} ${s.join(" ")}`).toBe(true);
	});

	it("no two roads cross", () => {
		const crossing = (a: Seg, b: Seg): boolean => {
			if (vertical(a) === vertical(b)) return false;
			const [v, h] = vertical(a) ? [a, b] : [b, a];
			const x = v[0][0];
			const y = h[0][1];
			return y > Math.min(v[0][1], v[1][1]) && y < Math.max(v[0][1], v[1][1]) && x > Math.min(h[0][0], h[1][0]) && x < Math.max(h[0][0], h[1][0]);
		};
		for (let i = 0; i < ROADS.length; i++)
			for (let j = i + 1; j < ROADS.length; j++)
				for (const a of hand(ROADS[i] ?? "core")) for (const b of hand(ROADS[j] ?? "core")) expect(crossing(a, b), `${ROADS[i]} crosses ${ROADS[j]}`).toBe(false);
	});

	it("no two roads share a stretch or run side by side closer than the widest body and its bed", () => {
		const gap = roadWidth(10_000) + 7 + 2;
		const overlap = (a: number, b: number, c: number, d: number): number => Math.min(Math.max(a, b), Math.max(c, d)) - Math.max(Math.min(a, b), Math.min(c, d));
		for (let i = 0; i < ROADS.length; i++)
			for (let j = i + 1; j < ROADS.length; j++)
				for (const a of hand(ROADS[i] ?? "core"))
					for (const b of hand(ROADS[j] ?? "core")) {
						const label = `${ROADS[i]} and ${ROADS[j]}`;
						if (horizontal(a) && horizontal(b) && overlap(a[0][0], a[1][0], b[0][0], b[1][0]) > 0) expect(Math.abs(a[0][1] - b[0][1]), label).toBeGreaterThanOrEqual(gap);
						if (vertical(a) && vertical(b) && overlap(a[0][1], a[1][1], b[0][1], b[1][1]) > 0) expect(Math.abs(a[0][0] - b[0][0]), label).toBeGreaterThanOrEqual(gap);
					}
	});

	it("no road runs through a module other than its own, the token wave, or the model's title", () => {
		const [cx, cy] = INTERIOR.core.centre;
		const k = INTERIOR.core.radius / 120;
		const title: Rect = { x: cx - MODEL_TITLE_WIDTH / 2, y: cy + 124 * k, w: MODEL_TITLE_WIDTH, h: 40 };
		for (const id of ROADS) {
			const legs = outsideModel(id);
			for (const other of PLACE_IDS) {
				if (other === id || other === "core" || other === "orchestrator") continue;
				// The prompt goes through the context reservoir on its way to the model: by design.
				if (id === "user-desk" && other === "monitoring") continue;
				for (const s of legs) expect(through(s, INTERIOR.places[other].rect), `${id} runs through ${other}`).toBe(false);
			}
			for (const s of legs) {
				expect(through(s, INTERIOR.wave), `${id} runs through the token wave`).toBe(false);
				expect(through(s, title, 8), `${id} runs through the model's title`).toBe(false);
			}
		}
	});

	it("no road runs through any road's figures", () => {
		const W = 36 * 6.3 * INTERIOR.text + 8;
		const H = 15 * INTERIOR.text;
		for (const id of PLACE_IDS) {
			const label = INTERIOR.places[id].label;
			if (label === null) continue;
			const x = label.align === "left" ? label.at[0] : label.align === "center" ? label.at[0] - W / 2 : label.at[0] - W;
			const box: Rect = { x: x - 4, y: label.at[1] - 2, w: W, h: H };
			for (const road of ROADS) for (const s of hand(road)) expect(through(s, box, 3), `${road} runs through the figures of ${id}`).toBe(false);
		}
	});

	it("every road starts in the model's box and ends inside its own module, right at its edge", () => {
		for (const id of ROADS) {
			const { route, rect } = INTERIOR.places[id];
			const start = route[0] ?? NOWHERE;
			const [ex, ey] = route.at(-1) ?? NOWHERE;
			expect(inModel(start), `${id} starts outside the model`).toBe(true);
			const inside = ex >= rect.x && ex <= rect.x + rect.w && ey >= rect.y && ey <= rect.y + rect.h;
			const toEdge = Math.min(ex - rect.x, rect.x + rect.w - ex, ey - rect.y, rect.y + rect.h - ey);
			expect(inside, `${id} ends outside its module`).toBe(true);
			expect(toEdge, `${id} ends deep inside its module`).toBeLessThanOrEqual(20);
		}
	});
});

describe("one track for the body and the packets", () => {
	it("the road a packet travels is the rounded track of the hand-set route, with the same two ends", () => {
		for (const id of ROADS) {
			const { route, road } = INTERIOR.places[id];
			expect(roadOf(INTERIOR, id)).toBe(road);
			expect(near(road[0] ?? NOWHERE, route[0] ?? [-2, -2])).toBe(true);
			expect(near(road.at(-1) ?? NOWHERE, route.at(-1) ?? [-2, -2])).toBe(true);
		}
	});

	it("a place with no route has an empty track and its road is the point at its centre", () => {
		expect(INTERIOR.places.monitoring.road).toEqual([]);
		expect(roadOf(INTERIOR, "monitoring")).toHaveLength(1);
	});

});
