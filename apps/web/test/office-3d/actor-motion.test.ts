import { describe, expect, it } from "vitest";
import { MAX_WALK_METRES } from "../../src/machines/office/office-layout.ts";
import { MAX_WALK_SECONDS, paceOf, routeSeconds, sampleRoute, WALK_SPEED } from "../../src/office-3d/character/actor-motion.ts";
import type { Route } from "../../src/office-3d/character/office-routes.ts";

const STILL = { x: 9, z: 9, heading: 0 };
const STEP = WALK_SPEED;

const SHORT: Route = {
	legs: [
		{
			kind: "walk",
			points: [
				{ x: 0, z: 0, node: null },
				{ x: 0, z: STEP, node: "a" },
				{ x: STEP, z: STEP, node: "b" },
			],
		},
	],
};

describe("actor motion", () => {
	it("walks a short route at the normal pace and faces the way it goes", () => {
		expect(paceOf(SHORT)).toBe(WALK_SPEED);
		expect(routeSeconds(SHORT)).toBeCloseTo(2);
		const mid = sampleRoute(SHORT, 0.5, STILL);
		expect(mid).toMatchObject({ moving: true, done: false });
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

	it("walks a long route faster so its walking stays under the cap", () => {
		const long: Route = {
			legs: [
				{
					kind: "walk",
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

	it("gives the longest walk of the plan time enough to stay a walk, not a dash", () => {
		// The layout check caps a walk between anchors at MAX_WALK_METRES; at the cap the pace stays under a jog.
		expect(MAX_WALK_SECONDS).toBeGreaterThanOrEqual(12);
		expect(MAX_WALK_METRES / MAX_WALK_SECONDS).toBeLessThan(4);
	});
});
