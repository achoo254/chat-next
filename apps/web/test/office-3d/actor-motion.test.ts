import { describe, expect, it } from "vitest";
import { MAX_WALK_SECONDS, paceOf, routeSeconds, sampleRoute, WALK_SPEED } from "../../src/office-3d/character/actor-motion.ts";
import type { Route } from "../../src/office-3d/character/office-routes.ts";

const STILL = { floor: 1 as const, x: 9, z: 9, heading: 0 };
const STEP = WALK_SPEED;

const SHORT: Route = {
	legs: [
		{
			kind: "walk",
			floor: 1,
			points: [
				{ x: 0, z: 0, node: null },
				{ x: 0, z: STEP, node: "a" },
				{ x: STEP, z: STEP, node: "b" },
			],
		},
	],
};

const VIA_LIFT: Route = {
	legs: [
		{
			kind: "walk",
			floor: 1,
			points: [
				{ x: 0, z: 0, node: null },
				{ x: STEP, z: 0, node: "lift-1" },
			],
		},
		{ kind: "lift", from: 1, to: 2, seconds: 3.5, x: STEP, z: 0 },
		{
			kind: "walk",
			floor: 2,
			points: [
				{ x: STEP, z: 0, node: "lift-2" },
				{ x: STEP, z: 2 * STEP, node: null },
			],
		},
	],
};

describe("actor motion", () => {
	it("walks a short route at the normal pace and faces the way it goes", () => {
		expect(paceOf(SHORT)).toBe(WALK_SPEED);
		expect(routeSeconds(SHORT)).toBeCloseTo(2);
		const mid = sampleRoute(SHORT, 0.5, STILL);
		expect(mid).toMatchObject({ floor: 1, moving: true, done: false, inLift: false });
		expect(mid.z).toBeCloseTo(STEP / 2);
		expect(mid.heading).toBeCloseTo(0);
		const turn = sampleRoute(SHORT, 1.5, STILL);
		expect(turn.x).toBeCloseTo(STEP / 2);
		expect(turn.heading).toBeCloseTo(Math.PI / 2);
	});

	it("names the walkway node a new route may start from (the end of the segment, else its start)", () => {
		expect(sampleRoute(SHORT, 0.5, STILL).resume?.node).toBe("a");
		expect(sampleRoute(SHORT, 1.5, STILL).resume?.node).toBe("b");
	});

	it("stands at the last point once done, and stays put on an empty route", () => {
		expect(sampleRoute(SHORT, 99, STILL)).toMatchObject({ x: STEP, z: STEP, moving: false, done: true });
		expect(sampleRoute({ legs: [] }, 3, STILL)).toMatchObject({ x: 9, z: 9, done: true, moving: false });
		expect(sampleRoute(SHORT, Number.NaN, STILL)).toMatchObject({ x: 0, z: 0 });
	});

	it("is out of sight in the elevator and comes out on the other floor", () => {
		expect(sampleRoute(VIA_LIFT, 1 + 1, STILL)).toMatchObject({ inLift: true, floor: 2, moving: false });
		const out = sampleRoute(VIA_LIFT, 1 + 3.5 + 0.5, STILL);
		expect(out).toMatchObject({ inLift: false, floor: 2, moving: true });
		expect(out.z).toBeCloseTo(0.5 * WALK_SPEED);
	});

	it("walks a long route faster so its walking stays under the cap", () => {
		const long: Route = {
			legs: [
				{
					kind: "walk",
					floor: 1,
					points: [
						{ x: 0, z: 0, node: null },
						{ x: 40, z: 0, node: null },
					],
				},
			],
		};
		expect(paceOf(long)).toBeCloseTo(40 / MAX_WALK_SECONDS);
		expect(routeSeconds(long)).toBeCloseTo(MAX_WALK_SECONDS);
		expect(sampleRoute(long, MAX_WALK_SECONDS + 0.01, STILL).done).toBe(true);
	});
});
