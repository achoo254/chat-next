// The building's layout file and its checker: the shipped file is valid and
// roomy enough; broken layouts say what is wrong instead of throwing.
import { describe, expect, it } from "vitest";
import { anchorOfKind, deskOrder, floorOfRoom, projectPoint, spotsOf } from "../../src/machines/office/office-geometry.ts";
import { OFFICE_LAYOUT, OFFICE_LAYOUT_TEXT, parseOfficeLayout, type OfficeLayout } from "../../src/machines/office/office-layout.ts";
import { ROOM_CODES } from "../../src/machines/office/office-rooms.ts";

type Json = Record<string, unknown>;

/** A fresh copy of the shipped file to break. */
function raw(): Json {
	return JSON.parse(OFFICE_LAYOUT_TEXT) as Json;
}

function floors(json: Json): Json[] {
	return json.floors as Json[];
}

function shipped(): OfficeLayout {
	if (!OFFICE_LAYOUT.ok) throw new Error(OFFICE_LAYOUT.errors.join("\n"));
	return OFFICE_LAYOUT.value;
}

function errorsOf(json: unknown): readonly string[] {
	const result = parseOfficeLayout(json);
	return result.ok ? [] : result.errors;
}

describe("the building's layout", () => {
	it("ships valid: 4 floors, the 12 work rooms and the 3 living rooms once each, 8 desks and the phone's 6", () => {
		const layout = shipped();
		expect(layout.floors.map((f) => f.level)).toEqual([1, 2, 3, 4]);
		expect(layout.floors.flatMap((f) => f.rooms.map((r) => r.room)).sort()).toEqual([...ROOM_CODES].sort());
		expect(deskOrder(layout, "desktop")).toHaveLength(8);
		expect(deskOrder(layout, "phone")).toHaveLength(6);
		expect(floorOfRoom(layout, "LOBBY")).toBe(1);
		expect(floorOfRoom(layout, "POST")).toBe(2);
		expect(floorOfRoom(layout, "QA")).toBe(3);
		for (const room of ["DORM", "GYM", "LOUNGE"] as const) expect(floorOfRoom(layout, room), room).toBe(4);
	});

	it("gives the living floor beds, gym stations with their exercise, TV seats and a dining table", () => {
		const layout = shipped();
		const living = layout.floors.find((f) => f.level === 4)?.anchors ?? [];
		const beds = living.filter((a) => a.kind === "bed");
		expect(beds).toHaveLength(8);
		for (const bed of beds) expect(bed).toMatchObject({ room: "DORM", lie: true, y: 0.5 });
		const gym = living.filter((a) => a.kind === "gym");
		expect(gym.map((a) => a.act).sort()).toEqual(["jacks", "punch", "pushup", "pushup", "run", "run"]);
		for (const tread of gym.filter((a) => a.act === "run")) expect(tread.y).toBeCloseTo(0.18);
		expect(living.filter((a) => a.kind === "tv" && a.sit)).toHaveLength(7);
		expect(living.filter((a) => a.kind === "tv" && a.low)).toHaveLength(2);
		expect(living.filter((a) => a.kind === "dine" && a.sit)).toHaveLength(6);
		expect(living.filter((a) => a.kind === "counter")).toHaveLength(1);
	});

	it("refuses a gym station without its exercise", () => {
		const json = JSON.parse(OFFICE_LAYOUT_TEXT) as { floors: { level: number; anchors: { kind: string; act?: string }[] }[] };
		const station = json.floors.find((f) => f.level === 4)?.anchors.find((a) => a.kind === "gym");
		if (station !== undefined) delete station.act;
		expect(errorsOf(json).some((e) => e.includes("needs an act"))).toBe(true);
	});

	it("gives every room room for at least three people, the director a chair, the chairman a spot, and the four boards", () => {
		const layout = shipped();
		for (const room of ROOM_CODES) expect(spotsOf(layout, room).length, room).toBeGreaterThanOrEqual(3);
		expect(anchorOfKind(layout, "DIRECTOR", "director")).toBeDefined();
		expect(anchorOfKind(layout, "LOBBY", "chairman")).toBeDefined();
		for (const room of ["LOBBY", "PLANNING", "AUDIT", "QA"] as const) expect(anchorOfKind(layout, room, "board"), room).toBeDefined();
	});

	it("projects every anchor inside the default camera's picture, desktop and phone", () => {
		const layout = shipped();
		for (const size of ["desktop", "phone"] as const) {
			for (const a of layout.floors.flatMap((f) => f.anchors)) {
				const [x, y] = projectPoint(layout.camera, layout.camera.views[size], a.x, 0, a.z);
				expect(x, `${a.id} ${size}`).toBeGreaterThan(0);
				expect(x, `${a.id} ${size}`).toBeLessThan(100);
				expect(y, `${a.id} ${size}`).toBeGreaterThan(0);
				expect(y, `${a.id} ${size}`).toBeLessThan(100);
			}
		}
		// The target lands in the middle.
		const [cx, cy] = projectPoint(layout.camera, layout.camera.views.desktop, ...layout.camera.target);
		expect([cx, cy]).toEqual([50, 50]);
	});

	it("refuses another format version, and anything that is not an object", () => {
		const json = raw();
		json.formatVersion = 2;
		expect(errorsOf(json)[0]).toMatch(/format version 2/);
		expect(errorsOf(null)).toEqual(["the layout is not a JSON object"]);
	});

	it("says when a room is missing or appears twice", () => {
		const missing = raw();
		const third = floors(missing)[2] as Json;
		third.rooms = (third.rooms as Json[]).filter((r) => r.room !== "QA");
		expect(errorsOf(missing)).toContain("QA appears 0 times, expected once");
		const twice = raw();
		const second = floors(twice)[1] as Json;
		(second.rooms as Json[]).push({ room: "LOBBY", name: "Sảnh 2", rect: [0, 0, 1, 1] });
		expect(errorsOf(twice)).toContain("LOBBY appears 2 times, expected once");
	});

	it("says when the work room lacks desks or the phone order names something else", () => {
		const json = raw();
		const first = floors(json)[0] as Json;
		first.anchors = (first.anchors as Json[]).filter((a) => a.id !== "desk-7");
		expect(errorsOf(json)).toContain("floor 1 has 7 desks in WORK, expected 8");
		const order = raw();
		(floors(order)[0] as Json).phoneDeskOrder = ["desk-1", "desk-1", "desk-2", "desk-3", "desk-4", "desk-5"];
		expect(errorsOf(order)).toContain("floor 1 phoneDeskOrder must name 6 different desks of WORK");
	});

	it("says when a floor's walkways are cut", () => {
		const json = raw();
		const second = floors(json)[1] as Json;
		const graph = second.graph as Json;
		graph.edges = (graph.edges as string[][]).filter(([a, b]) => !(a === "f2-hall-post" || b === "f2-hall-post"));
		expect(errorsOf(json).some((e) => e.startsWith("floor 2: walkway graph is cut"))).toBe(true);
	});

	it("says when the elevator misses a floor", () => {
		const json = raw();
		const lift = json.elevator as Json;
		lift.nodes = { ...(lift.nodes as Json), 3: "nowhere" };
		expect(errorsOf(json)).toContain("the elevator does not reach floor 3");
		const noNode = raw();
		(floors(noNode)[2] as Json).elevatorNode = "missing";
		expect(errorsOf(noNode)).toContain("floor 3: no elevator node in its walkway graph");
	});

	it("says when anchor ids repeat, or a room has no door or no place to stand", () => {
		const json = raw();
		const first = floors(json)[0] as Json;
		(first.anchors as Json[]).push({ id: "desk-0", kind: "work", room: "LOBBY", x: 0, z: -10, node: "f1-lobby-mid" });
		expect(errorsOf(json)).toContain("anchor ids used twice: desk-0");
		const noDoor = raw();
		const third = floors(noDoor)[2] as Json;
		third.doors = (third.doors as Json[]).filter((d) => d.id !== "door-qa");
		third.anchors = (third.anchors as Json[]).filter((a) => a.room !== "AUDIT" || a.kind !== "work");
		const errors = errorsOf(noDoor);
		expect(errors).toContain("floor 3: QA has no door");
		expect(errors).toContain("floor 3: AUDIT has no place to stand");
	});
});
