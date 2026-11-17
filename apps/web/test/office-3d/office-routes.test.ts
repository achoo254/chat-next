import { describe, expect, it } from "vitest";
import { OFFICE_LAYOUT, SPOT_KINDS, type OfficeLayout } from "../../src/machines/office/office-layout.ts";
import { ROOM_CODES } from "../../src/machines/office/office-rooms.ts";
import { createRouter, type Leg, type Route, type Spot } from "../../src/office-3d/character/office-routes.ts";
import { SCENE_LAYOUT, segmentsMinusDoors, type Segment } from "../../src/office-3d/scene/scene-layout.ts";

function layout(): OfficeLayout {
	if (!OFFICE_LAYOUT.ok) throw new Error(OFFICE_LAYOUT.errors.join("; "));
	return OFFICE_LAYOUT.value;
}

/** The places to stand in each room, as route ends. */
function roomSpots(l: OfficeLayout): { room: string; spot: Spot }[] {
	return ROOM_CODES.flatMap((room) => l.anchors.filter((a) => a.room === room && SPOT_KINDS.includes(a.kind)).map((a) => ({ room, spot: { x: a.x, z: a.z, node: a.node } })));
}

/** Proper crossing of two segments (touching at an end does not count). */
function crosses(a: Segment, b: Segment): boolean {
	const [ax, az, bx, bz] = a;
	const [cx, cz, dx, dz] = b;
	const d = (bx - ax) * (dz - cz) - (bz - az) * (dx - cx);
	if (Math.abs(d) < 1e-9) return false;
	const t = ((cx - ax) * (dz - cz) - (cz - az) * (dx - cx)) / d;
	const u = ((cx - ax) * (bz - az) - (cz - az) * (bx - ax)) / d;
	const e = 1e-3;
	return t > e && t < 1 - e && u > e && u < 1 - e;
}

function walkSegments(leg: Leg): Segment[] {
	const out: Segment[] = [];
	for (let i = 1; i < leg.points.length; i += 1) {
		const a = leg.points[i - 1];
		const b = leg.points[i];
		if (a !== undefined && b !== undefined) out.push([a.x, a.z, b.x, b.z]);
	}
	return out;
}

describe("office routes", () => {
	const l = layout();
	const router = createRouter(l);
	const spots = roomSpots(l);
	const firstOf = (room: string): Spot => {
		const found = spots.find((s) => s.room === room)?.spot;
		if (found === undefined) throw new Error(`no spot in ${room}`);
		return found;
	};
	const nodesOf = (route: Route): (string | null)[] => route.legs.flatMap((leg) => leg.points.map((p) => p.node));

	it("has a place to stand in every room", () => {
		for (const room of ROOM_CODES) expect(spots.some((s) => s.room === room), room).toBe(true);
	});

	it("finds a way between every two places of the plan in one walk, never through glass, walls or low walls", () => {
		const barriers = [...SCENE_LAYOUT.glass, ...SCENE_LAYOUT.walls, ...SCENE_LAYOUT.lowWalls].flatMap((seg) => segmentsMinusDoors(seg, SCENE_LAYOUT.doors));
		for (const from of spots) {
			for (const to of spots) {
				const route = router.route(from.spot, to.spot);
				const label = `${from.room}(${from.spot.x},${from.spot.z}) → ${to.room}(${to.spot.x},${to.spot.z})`;
				expect(route.legs, label).toHaveLength(1);
				const leg = route.legs[0];
				if (leg === undefined) continue;
				expect(leg.points[0], label).toMatchObject({ x: from.spot.x, z: from.spot.z });
				expect(leg.points[leg.points.length - 1], label).toMatchObject({ x: to.spot.x, z: to.spot.z });
				for (const step of walkSegments(leg)) {
					const hit = barriers.find((b) => crosses(step, b));
					expect(hit, `${label}: ${step.join(",")} crosses ${hit?.join(",") ?? ""}`).toBeUndefined();
				}
			}
		}
	});

	it("walks from the lobby to QA across the front link between the zones, without an elevator", () => {
		const route = router.route(firstOf("LOBBY"), firstOf("QA"));
		expect(route.legs.map((leg) => leg.kind)).toEqual(["walk"]);
		const nodes = nodesOf(route);
		expect(nodes).toContain("link-front");
		expect(nodes).toContain("door-qa");
	});

	it("walks from the work room to the library through the work room's back door", () => {
		const nodes = nodesOf(router.route(firstOf("WORK"), firstOf("LIBRARY")));
		expect(nodes).toContain("door-work-back");
		expect(nodes).toContain("door-library");
	});

	it("walks through the door nodes when changing rooms of one zone", () => {
		const nodes = nodesOf(router.route(firstOf("DIRECTOR"), firstOf("PANTRY")));
		expect(nodes).toContain("door-director");
		expect(nodes).toContain("door-pantry");
	});

	it("crosses a room straight when both places join the walkway at one node", () => {
		const a = l.anchors.find((x) => x.id === "desk-0");
		const b = l.anchors.find((x) => x.id === "desk-1");
		if (a === undefined || b === undefined) throw new Error("desks missing");
		const route = router.route({ x: a.x, z: a.z, node: a.node }, { x: b.x, z: b.z, node: b.node });
		expect(route.legs).toHaveLength(1);
		expect(route.legs[0]?.points).toHaveLength(2);
	});

	it("knows node positions of the plan", () => {
		expect(router.nodeAt("link-mid")).toEqual({ x: expect.any(Number), z: expect.any(Number) });
		expect(router.nodeAt("f1-elevator")).toBeNull();
	});
});
