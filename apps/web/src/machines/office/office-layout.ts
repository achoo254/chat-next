// The building's layout (office-layout.json, in metres): the single source of
// its geometry for the 2D view, the 3D scene and the Blender assembly and
// bake (which reads the same file). parseOfficeLayout checks what everything
// downstream relies on and says what is wrong instead of throwing. The file
// comes in as text so its hash (office-assets.ts) is over the exact bytes the
// assets were baked from; it lives in the lazy chunk of machines/office/.
import layoutText from "./office-layout.json?raw";
import { FLOOR_LEVELS, isRoomCode, ROOM_CODES, type FloorLevel, type RoomCode } from "./office-rooms.ts";
import { arrayOf, isRecord, numberOf, stringOf, type Parsed } from "./office-json.ts";

export const LAYOUT_FORMAT_VERSION = 1;
/** Home desks of the shared work room on floor 1, and how many of them a phone uses. */
export const LAYOUT_DESKS = 8;
export const LAYOUT_PHONE_DESKS = 6;

export type Rect = readonly [number, number, number, number];

export type AnchorKind = "desk" | "director" | "work" | "server" | "pantry" | "sofa" | "meeting" | "lobby" | "chairman" | "board" | "elevator";

const ANCHOR_KINDS: readonly AnchorKind[] = ["desk", "director", "work", "server", "pantry", "sofa", "meeting", "lobby", "chairman", "board", "elevator"];

/** Anchors a person may stand or sit at while working in a room (desks, the director's chair, the chairman's spot, boards and elevators are not). */
export const SPOT_KINDS: readonly AnchorKind[] = ["work", "server", "pantry", "sofa", "meeting", "lobby"];

export interface LayoutAnchor {
	readonly id: string;
	readonly kind: AnchorKind;
	readonly room: RoomCode | null;
	readonly x: number;
	readonly z: number;
	/** Facing, Babylon rotation.y (0 looks to +z). */
	readonly face: number;
	readonly node: string;
}

export interface LayoutRoom {
	readonly room: RoomCode;
	readonly name: string;
	readonly rect: Rect;
}

export interface LayoutFloor {
	readonly level: FloorLevel;
	readonly name: string;
	readonly rooms: readonly LayoutRoom[];
	readonly doors: readonly { readonly id: string; readonly between: readonly (RoomCode | null)[] }[];
	readonly anchors: readonly LayoutAnchor[];
	/** The six desks a phone uses, in the order employees take them (floor 1 only). */
	readonly phoneDeskOrder: readonly string[];
	readonly graph: { readonly nodes: readonly { readonly id: string; readonly x: number; readonly z: number }[]; readonly edges: readonly (readonly [string, string])[] };
	readonly elevatorNode: string;
}

export interface CameraView {
	readonly aspect: number;
	readonly orthoHeight: number;
}

export interface LayoutCamera {
	readonly yaw: number;
	readonly pitch: number;
	readonly target: readonly [number, number, number];
	readonly views: { readonly desktop: CameraView; readonly phone: CameraView };
}

/**
 * What the app reads of the layout. The file holds more (glass walls, door
 * positions, furniture and small props) for the 3D scene and the Blender
 * assembly, which read those fields themselves.
 */
export interface OfficeLayout {
	readonly formatVersion: number;
	readonly floors: readonly LayoutFloor[];
	readonly camera: LayoutCamera;
	readonly elevator: { readonly travelSecondsPerFloor: number; readonly nodes: Readonly<Record<FloorLevel, string>> };
}

export type { Parsed } from "./office-json.ts";

/** The layout file's text exactly as shipped (hashed by office-assets.ts). */
export const OFFICE_LAYOUT_TEXT: string = layoutText;

function parseCamera(value: unknown, errors: string[]): LayoutCamera {
	const c = isRecord(value) ? value : {};
	const view = (v: unknown, name: string): CameraView => {
		const r = isRecord(v) ? v : {};
		const aspect = numberOf(r.aspect);
		const orthoHeight = numberOf(r.orthoHeight);
		if (aspect === null || aspect <= 0 || orthoHeight === null || orthoHeight <= 0) errors.push(`defaultCamera.views.${name} needs a positive aspect and orthoHeight`);
		return { aspect: aspect ?? 1, orthoHeight: orthoHeight ?? 1 };
	};
	const target = arrayOf(c.target).map(numberOf);
	const yaw = numberOf(c.yaw);
	const pitch = numberOf(c.pitch);
	if (yaw === null || pitch === null || target.length !== 3 || target.some((n) => n === null)) errors.push("defaultCamera needs yaw, pitch and a target [x, y, z]");
	const views = isRecord(c.views) ? c.views : {};
	return {
		yaw: yaw ?? 0,
		pitch: pitch ?? 0,
		target: [target[0] ?? 0, target[1] ?? 0, target[2] ?? 0],
		views: { desktop: view(views.desktop, "desktop"), phone: view(views.phone, "phone") },
	};
}

function parseFloor(value: unknown, errors: string[]): LayoutFloor | null {
	if (!isRecord(value)) return null;
	const level = numberOf(value.level);
	if (level !== 1 && level !== 2 && level !== 3) {
		errors.push(`a floor has level ${String(value.level)}, expected 1, 2 or 3`);
		return null;
	}
	const roomOrNull = (v: unknown): RoomCode | null => (isRoomCode(v) ? v : null);
	const rooms: LayoutRoom[] = [];
	for (const r of arrayOf(value.rooms)) {
		const rec = isRecord(r) ? r : {};
		const rect = arrayOf(rec.rect).map(numberOf);
		if (!isRoomCode(rec.room)) {
			errors.push(`floor ${level}: unknown room ${String(rec.room)}`);
			continue;
		}
		if (rect.length !== 4 || rect.some((n) => n === null)) errors.push(`floor ${level}: ${rec.room} needs a rect [x0, z0, x1, z1]`);
		rooms.push({ room: rec.room, name: stringOf(rec.name), rect: [rect[0] ?? 0, rect[1] ?? 0, rect[2] ?? 0, rect[3] ?? 0] });
	}
	const anchors: LayoutAnchor[] = [];
	for (const a of arrayOf(value.anchors)) {
		const rec = isRecord(a) ? a : {};
		const kind = ANCHOR_KINDS.find((k) => k === rec.kind);
		const x = numberOf(rec.x);
		const z = numberOf(rec.z);
		const id = stringOf(rec.id);
		if (id === "" || kind === undefined || x === null || z === null) {
			errors.push(`floor ${level}: anchor ${id || "(no id)"} needs an id, a known kind and x, z`);
			continue;
		}
		anchors.push({ id, kind, room: roomOrNull(rec.room), x, z, face: numberOf(rec.face) ?? 0, node: stringOf(rec.node) });
	}
	const graph = isRecord(value.graph) ? value.graph : {};
	const nodes = arrayOf(graph.nodes).flatMap((n) => {
		const rec = isRecord(n) ? n : {};
		const id = stringOf(rec.id);
		return id === "" ? [] : [{ id, x: numberOf(rec.x) ?? 0, z: numberOf(rec.z) ?? 0 }];
	});
	const edges = arrayOf(graph.edges).flatMap((e): (readonly [string, string])[] => {
		const pair = arrayOf(e).map(stringOf);
		return pair.length === 2 ? [[pair[0] ?? "", pair[1] ?? ""]] : [];
	});
	const doors = arrayOf(value.doors).map((d) => {
		const rec = isRecord(d) ? d : {};
		return { id: stringOf(rec.id), between: arrayOf(rec.between).map(roomOrNull) };
	});
	return {
		level,
		name: stringOf(value.name),
		rooms,
		doors,
		anchors,
		phoneDeskOrder: arrayOf(value.phoneDeskOrder).map(stringOf),
		graph: { nodes, edges },
		elevatorNode: stringOf(value.elevatorNode),
	};
}

/** Every node of the floor is reachable from its elevator. */
function connected(floor: LayoutFloor): string[] {
	const links = new Map<string, string[]>(floor.graph.nodes.map((n) => [n.id, []]));
	for (const [a, b] of floor.graph.edges) {
		links.get(a)?.push(b);
		links.get(b)?.push(a);
	}
	const reached = new Set<string>(links.has(floor.elevatorNode) ? [floor.elevatorNode] : []);
	const queue = [...reached];
	for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
		for (const next of links.get(id) ?? []) {
			if (!reached.has(next)) {
				reached.add(next);
				queue.push(next);
			}
		}
	}
	return floor.graph.nodes.filter((n) => !reached.has(n.id)).map((n) => n.id);
}

function checkFloor(floor: LayoutFloor, errors: string[]): void {
	const at = `floor ${floor.level}`;
	const nodeIds = new Set(floor.graph.nodes.map((n) => n.id));
	for (const [a, b] of floor.graph.edges) if (!nodeIds.has(a) || !nodeIds.has(b)) errors.push(`${at}: edge ${a} - ${b} uses an unknown node`);
	if (!nodeIds.has(floor.elevatorNode)) errors.push(`${at}: no elevator node in its walkway graph`);
	const cut = connected(floor);
	if (cut.length > 0) errors.push(`${at}: walkway graph is cut, ${cut.join(", ")} not reachable from the elevator`);
	const here = new Set(floor.rooms.map((r) => r.room));
	for (const a of floor.anchors) {
		if (!nodeIds.has(a.node)) errors.push(`${at}: anchor ${a.id} points at unknown node ${a.node}`);
		if (a.room !== null && !here.has(a.room)) errors.push(`${at}: anchor ${a.id} is in ${a.room}, which is not on this floor`);
	}
	for (const r of floor.rooms) {
		if (!floor.doors.some((d) => d.between.includes(r.room))) errors.push(`${at}: ${r.room} has no door`);
		if (!floor.anchors.some((a) => a.room === r.room && SPOT_KINDS.includes(a.kind))) errors.push(`${at}: ${r.room} has no place to stand`);
	}
}

/** Reads and checks a layout file; `errors` say what is wrong, never a throw. */
export function parseOfficeLayout(json: unknown): Parsed<OfficeLayout> {
	if (!isRecord(json)) return { ok: false, errors: ["the layout is not a JSON object"] };
	const errors: string[] = [];
	if (json.formatVersion !== LAYOUT_FORMAT_VERSION) return { ok: false, errors: [`format version ${String(json.formatVersion)}, this app reads ${LAYOUT_FORMAT_VERSION}`] };
	const floors = arrayOf(json.floors).flatMap((f) => parseFloor(f, errors) ?? []);
	if (floors.length !== 3 || FLOOR_LEVELS.some((level) => floors.filter((f) => f.level === level).length !== 1)) errors.push("expected exactly 3 floors, levels 1, 2 and 3");
	for (const code of ROOM_CODES) {
		const count = floors.reduce((n, f) => n + f.rooms.filter((r) => r.room === code).length, 0);
		if (count !== 1) errors.push(`${code} appears ${count} times, expected once`);
	}
	for (const floor of floors) checkFloor(floor, errors);
	const ids = floors.flatMap((f) => f.anchors.map((a) => a.id));
	const repeated = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
	if (repeated.length > 0) errors.push(`anchor ids used twice: ${repeated.join(", ")}`);
	const first = floors.find((f) => f.level === 1);
	const desks = first?.anchors.filter((a) => a.kind === "desk" && a.room === "WORK") ?? [];
	if (desks.length !== LAYOUT_DESKS) errors.push(`floor 1 has ${desks.length} desks in WORK, expected ${LAYOUT_DESKS}`);
	const phone = first?.phoneDeskOrder ?? [];
	if (phone.length !== LAYOUT_PHONE_DESKS || new Set(phone).size !== phone.length || phone.some((id) => !desks.some((d) => d.id === id))) {
		errors.push(`floor 1 phoneDeskOrder must name ${LAYOUT_PHONE_DESKS} different desks of WORK`);
	}
	const lift = isRecord(json.elevator) ? json.elevator : {};
	const liftNodes = isRecord(lift.nodes) ? lift.nodes : {};
	const nodes = { 1: stringOf(liftNodes["1"]), 2: stringOf(liftNodes["2"]), 3: stringOf(liftNodes["3"]) };
	for (const floor of floors) if (nodes[floor.level] !== floor.elevatorNode || floor.elevatorNode === "") errors.push(`the elevator does not reach floor ${floor.level}`);
	const travel = numberOf(lift.travelSecondsPerFloor);
	if (travel === null || travel <= 0) errors.push("elevator.travelSecondsPerFloor must be a positive number");
	const camera = parseCamera(json.defaultCamera, errors);
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, value: { formatVersion: LAYOUT_FORMAT_VERSION, floors: [...floors].sort((a, b) => a.level - b.level), camera, elevator: { travelSecondsPerFloor: travel ?? 1, nodes } } };
}

function readShipped(): Parsed<OfficeLayout> {
	try {
		return parseOfficeLayout(JSON.parse(OFFICE_LAYOUT_TEXT));
	} catch (err) {
		return { ok: false, errors: [`office-layout.json is not JSON: ${err instanceof Error ? err.message : String(err)}`] };
	}
}

/** The shipped layout, checked once (tests keep it valid). */
export const OFFICE_LAYOUT: Parsed<OfficeLayout> = readShipped();
