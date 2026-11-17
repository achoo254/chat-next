// The layout's scene parts.
import { describe, expect, it } from "vitest";
import { parseSceneLayout, SCENE_LAYOUT, segmentsMinusDoors, type Door } from "../../src/office-3d/scene/scene-layout.ts";
import { PROP_SHAPES } from "../../src/office-3d/scene/placeholder-shapes.ts";
import { outerWallRuns, zoneOfPoint } from "../../src/office-3d/scene/placeholder-zone.ts";
import { OFFICE_LAYOUT } from "../../src/machines/office/office-layout.ts";

describe("scene layout", () => {
	it("reads the shipped plan whole: all fifteen rooms, glass, walls, low walls, windows, doors and furniture", () => {
		expect(SCENE_LAYOUT.rooms).toHaveLength(15);
		expect(SCENE_LAYOUT.glass.length).toBeGreaterThan(0);
		expect(SCENE_LAYOUT.walls.length).toBeGreaterThan(0);
		expect(SCENE_LAYOUT.lowWalls.length).toBeGreaterThan(0);
		expect(SCENE_LAYOUT.windows.length).toBeGreaterThan(0);
		expect(SCENE_LAYOUT.doors.length).toBeGreaterThan(0);
		expect(SCENE_LAYOUT.props.length).toBeGreaterThan(0);
		expect(SCENE_LAYOUT.smallProps.length).toBeGreaterThan(0);
		expect(SCENE_LAYOUT.wallHeight).toBeGreaterThan(2);
		expect(SCENE_LAYOUT.lowWallHeight).toBeGreaterThan(0);
		expect(SCENE_LAYOUT.lowWallHeight).toBeLessThan(SCENE_LAYOUT.wallHeight);
		// Every room lies inside the plan's footprint.
		const [x0, z0, x1, z1] = SCENE_LAYOUT.footprint;
		for (const { room, rect } of SCENE_LAYOUT.rooms) expect(rect[0] >= x0 && rect[1] >= z0 && rect[2] <= x1 && rect[3] <= z1, room).toBe(true);
	});

	it("reads a free-standing board with its facing", () => {
		const free = SCENE_LAYOUT.decor.filter((d) => d.kind === "board" && d.wall === "free");
		expect(free.length).toBeGreaterThan(0);
		for (const board of free) expect(board.num.face).toEqual(expect.any(Number));
	});

	it("has a placeholder shape for every furniture and small-prop name of the layout", () => {
		const names = new Set([...SCENE_LAYOUT.props, ...SCENE_LAYOUT.smallProps].map((p) => p.name));
		const missing = [...names].filter((n) => PROP_SHAPES[n] === undefined);
		expect(missing).toEqual([]);
	});

	it("reads a broken or empty file as an empty plan instead of throwing", () => {
		const empty = parseSceneLayout(null);
		expect(empty).toMatchObject({ rooms: [], glass: [], walls: [], lowWalls: [], windows: [], doors: [], props: [], smallProps: [], decor: [] });
		expect(empty.footprint).toHaveLength(4);
		const odd = parseSceneLayout({
			glass: [[0, 0, 1], "x"],
			lowWalls: [[0, 0, 1, 0], [1]],
			windows: [{ wall: "back", from: 1 }],
			props: [{ name: "desk" }],
			rooms: [{ room: "NOPE", rect: [0, 0, 1, 1] }],
		});
		expect(odd).toMatchObject({ glass: [], lowWalls: [[0, 0, 1, 0]], windows: [], props: [], rooms: [] });
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

describe("placeholder zones", () => {
	if (!OFFICE_LAYOUT.ok) throw new Error(OFFICE_LAYOUT.errors.join("; "));
	const zones = OFFICE_LAYOUT.value.zones;
	const rooms = OFFICE_LAYOUT.value.rooms;

	it("puts every room in the zone the layout lists it in, and the corridor gaps between zones in the nearest", () => {
		for (const { room, rect } of SCENE_LAYOUT.rooms) {
			expect(zoneOfPoint(zones, (rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2), room).toBe(rooms.find((r) => r.room === room)?.zone);
		}
		// Between zones a (x up to 9) and c (x from 10.5), nearer a.
		expect(zoneOfPoint(zones, 9.5, 0)).toBe("a");
		expect(zoneOfPoint([], 0, 0)).toBeNull();
	});

	it("walls the plan's back and right edges once, across the corridor gaps, and nothing else", () => {
		const [fx0, fz0, fx1, fz1] = SCENE_LAYOUT.footprint;
		const runs = zones.flatMap((z) => outerWallRuns(z, zones, SCENE_LAYOUT.footprint).map((r) => [z.id, r] as const));
		const back = runs.filter(([, r]) => r[1] === fz1 && r[3] === fz1).map(([, r]) => [r[0], r[2]] as const).sort((a, b) => a[0] - b[0]);
		const right = runs.filter(([, r]) => r[0] === fx1 && r[2] === fx1).map(([, r]) => [r[1], r[3]] as const).sort((a, b) => a[0] - b[0]);
		expect(back.length + right.length).toBe(runs.length);
		// End to end, from the plan's left corner to its right one, and from its front to its back.
		expect(back[0]?.[0]).toBe(fx0);
		expect(back[back.length - 1]?.[1]).toBe(fx1);
		for (let i = 1; i < back.length; i += 1) expect(back[i]?.[0]).toBe(back[i - 1]?.[1]);
		expect(right[0]?.[0]).toBe(fz0);
		expect(right[right.length - 1]?.[1]).toBe(fz1);
		for (let i = 1; i < right.length; i += 1) expect(right[i]?.[0]).toBe(right[i - 1]?.[1]);
		// The front zone at the left has no tall wall: the camera looks in over it.
		expect(runs.filter(([id]) => id === "a")).toEqual([]);
	});
});
