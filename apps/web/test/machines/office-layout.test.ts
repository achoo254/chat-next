// The office's layout file and its checker: the shipped plan is valid, roomy
// enough and walkable end to end; broken layouts say what is wrong instead of
// throwing.
import { describe, expect, it } from "vitest";
import { anchorOfKind, deskOrder, projectPoint, spotsOf, zoneOfRoom } from "../../src/machines/office/office-geometry.ts";
import { MAX_WALK_METRES, OFFICE_LAYOUT, OFFICE_LAYOUT_TEXT, parseOfficeLayout, SPOT_KINDS, type OfficeLayout } from "../../src/machines/office/office-layout.ts";
import { ROOM_CODES } from "../../src/machines/office/office-rooms.ts";
import { buildWalkGraph, longestWalk } from "../../src/machines/office/office-walkways.ts";

type Json = Record<string, unknown>;

/** A fresh copy of the shipped file to break. */
function raw(): Json {
	return JSON.parse(OFFICE_LAYOUT_TEXT) as Json;
}

function list(json: Json, key: string): Json[] {
	return json[key] as Json[];
}

function shipped(): OfficeLayout {
	if (!OFFICE_LAYOUT.ok) throw new Error(OFFICE_LAYOUT.errors.join("\n"));
	return OFFICE_LAYOUT.value;
}

function errorsOf(json: unknown): readonly string[] {
	const result = parseOfficeLayout(json);
	return result.ok ? [] : result.errors;
}

describe("the office's layout", () => {
	it("ships valid: one plan of four zones, the 12 work rooms and the 3 living rooms once each, 8 desks and the phone's 6", () => {
		const layout = shipped();
		expect(layout.zones.map((z) => [z.id, [...z.rooms].sort()])).toEqual([
			["a", ["DIRECTOR", "LOBBY", "MEETING", "PANTRY", "SERVER", "WORK"]],
			["b", ["LIBRARY", "PLANNING", "POST"]],
			["c", ["AUDIT", "QA", "SECURITY"]],
			["d", ["DORM", "GYM", "LOUNGE"]],
		]);
		expect(layout.rooms.map((r) => r.room).sort()).toEqual([...ROOM_CODES].sort());
		expect(deskOrder(layout, "desktop")).toHaveLength(8);
		expect(deskOrder(layout, "phone")).toHaveLength(6);
		expect(zoneOfRoom(layout, "LOBBY")).toBe("a");
		expect(zoneOfRoom(layout, "POST")).toBe("b");
		expect(zoneOfRoom(layout, "QA")).toBe("c");
		for (const room of ["DORM", "GYM", "LOUNGE"] as const) expect(zoneOfRoom(layout, room), room).toBe("d");
	});

	it("gives the living rooms beds, gym stations with their exercise, TV seats and a dining table", () => {
		const layout = shipped();
		const living = layout.anchors.filter((a) => a.room !== null && zoneOfRoom(layout, a.room) === "d");
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
		const json = raw();
		const station = list(json, "anchors").find((a) => a.kind === "gym");
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
			for (const a of layout.anchors) {
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

	it("has a walkway between every two rooms", () => {
		const layout = shipped();
		const walk = buildWalkGraph(layout.graph);
		const nodeOf = (room: string): string => {
			const spot = layout.anchors.find((a) => a.room === room && SPOT_KINDS.includes(a.kind));
			if (spot === undefined) throw new Error(`no spot in ${room}`);
			return spot.node;
		};
		for (const from of ROOM_CODES) {
			for (const to of ROOM_CODES) expect(walk.shortestPath(nodeOf(from), nodeOf(to)).length, `${from} → ${to}`).toBeGreaterThan(0);
		}
	});

	it(`keeps the longest walk between two places people use within ${MAX_WALK_METRES} m`, () => {
		const layout = shipped();
		const longest = longestWalk(buildWalkGraph(layout.graph), [...new Set(layout.anchors.map((a) => a.node))]);
		expect(longest.metres, `${longest.from} → ${longest.to}`).toBeLessThanOrEqual(MAX_WALK_METRES);
		// The far corner (the dorm) is a real walk from the lobby, not a shortcut.
		expect(longest.metres).toBeGreaterThan(20);
	});

	it("refuses the four-floor format and other versions, and anything that is not an object", () => {
		const json = raw();
		json.formatVersion = 1;
		expect(errorsOf(json)).toEqual(["format version 1, this app reads 2"]);
		json.formatVersion = 3;
		expect(errorsOf(json)[0]).toMatch(/format version 3/);
		expect(errorsOf(null)).toEqual(["the layout is not a JSON object"]);
	});

	it("says when a room is missing or appears twice", () => {
		const missing = raw();
		missing.rooms = list(missing, "rooms").filter((r) => r.room !== "QA");
		expect(errorsOf(missing)).toContain("QA appears 0 times, expected once");
		const twice = raw();
		list(twice, "rooms").push({ room: "LOBBY", name: "Sảnh 2", rect: [0, 0, 1, 1] });
		expect(errorsOf(twice)).toContain("LOBBY appears 2 times, expected once");
	});

	it("says when a zone is missing or a room is in none", () => {
		const json = raw();
		json.zones = list(json, "zones").filter((z) => z.id !== "d");
		const errors = errorsOf(json);
		expect(errors).toContain("expected exactly the zones a, b, c, d");
		expect(errors).toContain("DORM is in no zone");
	});

	it("says when two zones list the same room", () => {
		const json = raw();
		const records = list(json, "zones").find((z) => z.id === "b");
		if (records === undefined) throw new Error("zone b missing");
		records.rooms = [...(records.rooms as string[]), "LOBBY"];
		expect(errorsOf(json)).toContain("LOBBY is listed by more than one zone (a, b)");
	});

	it("says when a room reaches outside its zone, and accepts a room sharing its zone's edge", () => {
		const json = raw();
		const zoneA = list(json, "zones").find((z) => z.id === "a");
		const lobby = list(json, "rooms").find((r) => r.room === "LOBBY");
		if (zoneA === undefined || lobby === undefined) throw new Error("zone a or LOBBY missing");
		const [x0, z0, x1, z1] = zoneA.rect as number[];
		if (x0 === undefined || z0 === undefined || x1 === undefined || z1 === undefined) throw new Error("zone a has no rect");
		// Exactly the zone's rect (written corners swapped) is still inside.
		lobby.rect = [x1, z1, x0, z0];
		expect(errorsOf(json).filter((e) => e.includes("outside its zone"))).toEqual([]);
		// A metre past the zone's right edge is not.
		lobby.rect = [x0, z0, Math.max(x0, x1) + 1, z1];
		expect(errorsOf(json)).toContain("LOBBY reaches outside its zone a");
	});

	it("says when the work room lacks desks or the phone order names something else", () => {
		const json = raw();
		json.anchors = list(json, "anchors").filter((a) => a.id !== "desk-7");
		expect(errorsOf(json)).toContain("WORK has 7 desks, expected 8");
		const order = raw();
		order.phoneDeskOrder = ["desk-1", "desk-1", "desk-2", "desk-3", "desk-4", "desk-5"];
		expect(errorsOf(order)).toContain("phoneDeskOrder must name 6 different desks of WORK");
	});

	it("says when the walkways are cut", () => {
		const json = raw();
		const graph = json.graph as Json;
		// The two ways into the records zone: the corridor link and the work room's back door.
		const cuts = new Set(["hall-post|link-back", "door-work-back|hall-library"]);
		graph.edges = (graph.edges as string[][]).filter((pair) => !cuts.has([...pair].sort().join("|")));
		const cut = errorsOf(json).find((e) => e.startsWith("walkway graph is cut"));
		expect(cut).toBeDefined();
		expect(cut).toContain("library");
		expect(cut).not.toContain("dorm");
	});

	it("says when an anchor stands outside its room's zone", () => {
		const json = raw();
		const qa = list(json, "anchors").find((a) => a.id === "qa-work-0");
		if (qa === undefined) throw new Error("qa-work-0 missing");
		// The middle of the work room, in zone a.
		qa.x = 0;
		qa.z = 0;
		expect(errorsOf(json)).toContain("anchor qa-work-0 stands outside Kiểm soát (zone c), the zone of QA");
	});

	it("says when anchor ids repeat, an anchor points at no node, or a room has no door or no place to stand", () => {
		const json = raw();
		list(json, "anchors").push({ id: "desk-0", kind: "work", room: "LOBBY", x: 0, z: -8, node: "lobby-mid" });
		expect(errorsOf(json)).toContain("anchor ids used twice: desk-0");
		const lost = raw();
		const chair = list(lost, "anchors").find((a) => a.id === "director");
		if (chair !== undefined) chair.node = "f1-director";
		expect(errorsOf(lost)).toContain("anchor director points at unknown node f1-director");
		const noDoor = raw();
		noDoor.doors = list(noDoor, "doors").filter((d) => d.id !== "door-qa" && d.id !== "door-qa-back");
		noDoor.anchors = list(noDoor, "anchors").filter((a) => a.room !== "AUDIT" || a.kind !== "work");
		const errors = errorsOf(noDoor);
		expect(errors).toContain("QA has no door");
		expect(errors).toContain("AUDIT has no place to stand");
	});
});
