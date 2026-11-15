import { describe, expect, it } from "vitest";
import { OFFICE_LAYOUT, SPOT_KINDS, type OfficeLayout } from "../../src/machines/office/office-layout.ts";
import { ROOM_CODES } from "../../src/machines/office/office-rooms.ts";
import { createRouter, type Leg, type Spot } from "../../src/office-3d/character/office-routes.ts";
import { SCENE_LAYOUT, segmentsMinusDoors, type Segment } from "../../src/office-3d/scene/scene-layout.ts";

function layout(): OfficeLayout {
	if (!OFFICE_LAYOUT.ok) throw new Error(OFFICE_LAYOUT.errors.join("; "));
	return OFFICE_LAYOUT.value;
}

/** The places to stand in each room, as route ends. */
function roomSpots(l: OfficeLayout): { room: string; spot: Spot }[] {
	return ROOM_CODES.flatMap((room) =>
		l.floors.flatMap((floor) =>
			floor.anchors.filter((a) => a.room === room && SPOT_KINDS.includes(a.kind)).map((a) => ({ room, spot: { floor: floor.level, x: a.x, z: a.z, node: a.node } })),
		),
	);
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
	if (leg.kind !== "walk") return [];
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
	const router = createRouter(l, SCENE_LAYOUT.doorSeconds);
	const spots = roomSpots(l);
	const firstOf = (room: string): Spot => {
		const found = spots.find((s) => s.room === room)?.spot;
		if (found === undefined) throw new Error(`no spot in ${room}`);
		return found;
	};

	it("has a place to stand in every room", () => {
		for (const room of ROOM_CODES) expect(spots.some((s) => s.room === room), room).toBe(true);
	});

	it("finds a way between every two places of the building, never through glass or walls", () => {
		for (const from of spots) {
			for (const to of spots) {
				const route = router.route(from.spot, to.spot);
				const label = `${from.room}(${from.spot.x},${from.spot.z}) → ${to.room}(${to.spot.x},${to.spot.z})`;
				expect(route.legs.length, label).toBeGreaterThan(0);
				const first = route.legs[0];
				const last = route.legs[route.legs.length - 1];
				expect(first?.kind === "walk" ? first.points[0] : null, label).toMatchObject({ x: from.spot.x, z: from.spot.z });
				expect(last?.kind === "walk" ? last.points[last.points.length - 1] : null, label).toMatchObject({ x: to.spot.x, z: to.spot.z });
				for (const leg of route.legs) {
					if (leg.kind !== "walk") continue;
					const floor = SCENE_LAYOUT.floors.find((f) => f.level === leg.floor);
					const barriers = [...(floor?.glass ?? []), ...(floor?.walls ?? [])].flatMap((seg) => segmentsMinusDoors(seg, floor?.doors ?? []));
					for (const step of walkSegments(leg)) {
						const hit = barriers.find((b) => crosses(step, b));
						expect(hit, `${label} on floor ${leg.floor}: ${step.join(",")} crosses ${hit?.join(",") ?? ""}`).toBeUndefined();
					}
				}
			}
		}
	});

	it("goes through the elevator nodes of both floors between floors, and rides for the layout's time", () => {
		const route = router.route(firstOf("LOBBY"), firstOf("QA"));
		expect(route.legs.map((leg) => leg.kind)).toEqual(["walk", "lift", "walk"]);
		const [down, ride, up] = route.legs;
		if (down?.kind !== "walk" || ride?.kind !== "lift" || up?.kind !== "walk") throw new Error("unexpected legs");
		expect(down.points[down.points.length - 1]?.node).toBe(l.elevator.nodes[1]);
		expect(up.points[0]?.node).toBe(l.elevator.nodes[3]);
		expect(ride).toMatchObject({ from: 1, to: 3, seconds: 2 * l.elevator.travelSecondsPerFloor + SCENE_LAYOUT.doorSeconds });
	});

	it("walks through the door nodes when changing rooms on one floor", () => {
		const [leg] = router.route(firstOf("DIRECTOR"), firstOf("PANTRY")).legs;
		const nodes = leg?.kind === "walk" ? leg.points.map((p) => p.node) : [];
		expect(nodes).toContain("f1-door-director");
		expect(nodes).toContain("f1-door-pantry");
	});

	it("crosses a room straight when both places join the walkway at one node", () => {
		const floor = l.floors[0];
		const a = floor?.anchors.find((x) => x.id === "desk-0");
		const b = floor?.anchors.find((x) => x.id === "desk-1");
		if (a === undefined || b === undefined) throw new Error("desks missing");
		const route = router.route({ floor: 1, x: a.x, z: a.z, node: a.node }, { floor: 1, x: b.x, z: b.z, node: b.node });
		expect(route.legs).toHaveLength(1);
		expect(route.legs[0]?.kind === "walk" ? route.legs[0].points : []).toHaveLength(2);
	});

	it("knows node positions by floor", () => {
		expect(router.nodeAt(1, l.elevator.nodes[1])).not.toBeNull();
		expect(router.nodeAt(2, l.elevator.nodes[1])).toBeNull();
	});
});
