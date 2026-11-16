// The layout's scene parts.
import { describe, expect, it } from "vitest";
import { parseSceneLayout, SCENE_LAYOUT, segmentsMinusDoors, type Door } from "../../src/office-3d/scene/scene-layout.ts";
import { PROP_SHAPES } from "../../src/office-3d/scene/placeholder-shapes.ts";

describe("scene layout", () => {
	it("reads all four floors of the shipped layout with their glass, doors and furniture", () => {
		expect(SCENE_LAYOUT.floors.map((f) => f.level)).toEqual([1, 2, 3, 4]);
		for (const floor of SCENE_LAYOUT.floors) {
			expect(floor.rooms.length, `floor ${floor.level}`).toBeGreaterThan(0);
			expect(floor.glass.length).toBeGreaterThan(0);
			expect(floor.doors.length).toBeGreaterThan(0);
			expect(floor.props.length).toBeGreaterThan(0);
		}
		expect(SCENE_LAYOUT.wallHeight).toBeGreaterThan(2);
	});

	it("has a placeholder shape for every furniture and small-prop name of the layout", () => {
		const names = new Set(SCENE_LAYOUT.floors.flatMap((f) => [...f.props, ...f.smallProps].map((p) => p.name)));
		const missing = [...names].filter((n) => PROP_SHAPES[n] === undefined);
		expect(missing).toEqual([]);
	});

	it("reads a broken or empty file as an empty building instead of throwing", () => {
		const empty = parseSceneLayout(null);
		expect(empty.floors).toEqual([]);
		expect(empty.footprint).toHaveLength(4);
		const odd = parseSceneLayout({ floors: [{ level: 1, glass: [[0, 0, 1], "x"], props: [{ name: "desk" }], rooms: [{ room: "NOPE", rect: [0, 0, 1, 1] }] }] });
		expect(odd.floors[0]).toMatchObject({ glass: [], props: [], rooms: [] });
	});

	it("cuts doorways out of a wall run along its axis, and leaves other runs alone", () => {
		const doors: Door[] = [
			{ id: "a", at: [0, -5], width: 1.6, axis: "x" },
			{ id: "b", at: [6, -5], width: 1, axis: "x" },
			{ id: "side", at: [-4.5, 0], width: 1, axis: "z" },
		];
		expect(segmentsMinusDoors([-4.5, -5, 9, -5], doors)).toEqual([
			[-4.5, -5, -0.8, -5],
			[0.8, -5, 5.5, -5],
			[6.5, -5, 9, -5],
		]);
		expect(segmentsMinusDoors([-4.5, -5, -4.5, 5], doors)).toEqual([
			[-4.5, -5, -4.5, -0.5],
			[-4.5, 0.5, -4.5, 5],
		]);
		expect(segmentsMinusDoors([0, 0, 3, 3], doors)).toEqual([[0, 0, 3, 3]]);
	});
});
