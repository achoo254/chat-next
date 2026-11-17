// The office's layout (office-layout.json, in metres): the single source of
// its geometry for the 2D view, the 3D scene and the Blender assembly and
// bake (which reads the same file). One floor plan of four zones; rooms,
// anchors and the walkway graph are the plan's, not a floor's. parseOfficeLayout
// checks what everything downstream relies on and says what is wrong instead
// of throwing. The file comes in as text so its hash (office-assets.ts) is
// over the exact bytes the assets were baked from; it lives in the lazy chunk
// of machines/office/.
import layoutText from "./office-layout.json?raw";
import { isRoomCode, ROOM_CODES, type RoomCode } from "./office-rooms.ts";
import { arrayOf, isRecord, numberOf, stringOf, type Parsed } from "./office-json.ts";
import { buildWalkGraph, longestWalk } from "./office-walkways.ts";

export const LAYOUT_FORMAT_VERSION = 2;
/** Home desks of the shared work room, and how many of them a phone uses. */
export const LAYOUT_DESKS = 8;
export const LAYOUT_PHONE_DESKS = 6;
/** The longest walk between two nodes anchors use, metres (the walk time cap in actor-motion.ts is sized for it). */
export const MAX_WALK_METRES = 45;

export type Rect = readonly [number, number, number, number];

/** The four zones of the plan: the unit of baked assets (one shell, lightmap pair and furniture file each). */
export const ZONE_IDS = ["a", "b", "c", "d"] as const;
export type ZoneId = (typeof ZONE_IDS)[number];

export function isZoneId(value: unknown): value is ZoneId {
	return typeof value === "string" && (ZONE_IDS as readonly string[]).includes(value);
}

export type AnchorKind =
	| "desk"
	| "director"
	| "work"
	| "server"
	| "pantry"
	| "sofa"
	| "meeting"
	| "lobby"
	| "chairman"
	| "board"
	| "bed"
	| "gym"
	| "tv"
	| "dine"
	| "counter";

const ANCHOR_KINDS: readonly AnchorKind[] = ["desk", "director", "work", "server", "pantry", "sofa", "meeting", "lobby", "chairman", "board", "bed", "gym", "tv", "dine", "counter"];

/** The living rooms' places (beds, gym stations, the TV corner's seats, the dining table and the counter): only the daily schedule sends people there. */
export const LIFE_KINDS: readonly AnchorKind[] = ["bed", "gym", "tv", "dine", "counter"];

/**
 * Anchors a person may stand, sit or lie at in a room (desks, the director's
 * chair, the chairman's spot and boards are not): the work rooms' spots and
 * the living rooms' places.
 */
export const SPOT_KINDS: readonly AnchorKind[] = ["work", "server", "pantry", "sofa", "meeting", "lobby", ...LIFE_KINDS];

/** What a gym station is for (the layout's `act`). */
export type GymAct = "run" | "pushup" | "jacks" | "punch";

const GYM_ACTS: readonly GymAct[] = ["run", "pushup", "jacks", "punch"];

export interface LayoutAnchor {
	readonly id: string;
	readonly kind: AnchorKind;
	readonly room: RoomCode | null;
	readonly x: number;
	readonly z: number;
	/** Facing, Babylon rotation.y (0 looks to +z). */
	readonly face: number;
	readonly node: string;
	/** Height the person stands or lies at over the floor, metres (a mattress top, a treadmill belt); 0 on the floor. */
	readonly y: number;
	/** Lying down there (a bed). */
	readonly lie: boolean;
	/** Sitting there (the living rooms' seats; work-room seats are known by their kind). */
	readonly sit: boolean;
	/** A low seat (a beanbag): sitting near the floor. */
	readonly low: boolean;
	/** A gym station's exercise; null elsewhere. */
	readonly act: GymAct | null;
}

export interface LayoutRoom {
	readonly room: RoomCode;
	readonly name: string;
	readonly rect: Rect;
	/** The zone the room is in (the zones' own room lists). */
	readonly zone: ZoneId;
}

export interface LayoutZone {
	readonly id: ZoneId;
	readonly name: string;
	readonly rect: Rect;
	readonly rooms: readonly RoomCode[];
}

export interface LayoutNode {
	readonly id: string;
	readonly x: number;
	readonly z: number;
}

export interface CameraView {
	readonly aspect: number;
	readonly orthoHeight: number;
}

export interface LayoutCamera {
	readonly yaw: number;
	readonly pitch: number;
	/** The middle of the whole plan; the views frame all of it. */
	readonly target: readonly [number, number, number];
	readonly views: { readonly desktop: CameraView; readonly phone: CameraView };
}

/**
 * What the app reads of the layout. The file holds more (glass and low walls,
 * door positions, furniture and small props) for the 3D scene and the Blender
 * assembly, which read those fields themselves.
 */
export interface OfficeLayout {
	readonly formatVersion: number;
	/** The whole plan [x0, z0, x1, z1]; only its back (largest z) and right (largest x) edges have tall walls. */
	readonly footprint: Rect;
	readonly zones: readonly LayoutZone[];
	readonly rooms: readonly LayoutRoom[];
	readonly doors: readonly { readonly id: string; readonly between: readonly (RoomCode | null)[] }[];
	readonly anchors: readonly LayoutAnchor[];
	/** The six desks a phone uses, in the order employees take them. */
	readonly phoneDeskOrder: readonly string[];
	readonly graph: { readonly nodes: readonly LayoutNode[]; readonly edges: readonly (readonly [string, string])[] };
	readonly camera: LayoutCamera;
}

export type { Parsed } from "./office-json.ts";

/** The layout file's text exactly as shipped (hashed by office-assets.ts). */
export const OFFICE_LAYOUT_TEXT: string = layoutText;

function rectOf(value: unknown): Rect | null {
	const r = arrayOf(value).map(numberOf);
	const [x0, z0, x1, z1] = r;
	return r.length === 4 && x0 != null && z0 != null && x1 != null && z1 != null ? [x0, z0, x1, z1] : null;
}

/** Rounding the layout writer may leave on a shared edge, metres. */
const EDGE_TOLERANCE = 1e-6;

/** Whether `inner` lies within `outer` (either corner order), edges shared allowed. */
function rectInside(inner: Rect, outer: Rect): boolean {
	const span = (a: number, b: number): [number, number] => (a <= b ? [a, b] : [b, a]);
	const within = (i: [number, number], o: [number, number]): boolean => i[0] >= o[0] - EDGE_TOLERANCE && i[1] <= o[1] + EDGE_TOLERANCE;
	return within(span(inner[0], inner[2]), span(outer[0], outer[2])) && within(span(inner[1], inner[3]), span(outer[1], outer[3]));
}

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

function parseZones(value: unknown, errors: string[]): LayoutZone[] {
	const zones: LayoutZone[] = [];
	for (const z of arrayOf(value)) {
		const rec = isRecord(z) ? z : {};
		const rect = rectOf(rec.rect);
		if (!isZoneId(rec.id) || rect === null) {
			errors.push(`a zone needs an id (${ZONE_IDS.join(", ")}) and a rect [x0, z0, x1, z1]`);
			continue;
		}
		zones.push({ id: rec.id, name: stringOf(rec.name), rect, rooms: arrayOf(rec.rooms).filter(isRoomCode) });
	}
	if (zones.length !== ZONE_IDS.length || ZONE_IDS.some((id) => zones.filter((z) => z.id === id).length !== 1)) errors.push(`expected exactly the zones ${ZONE_IDS.join(", ")}`);
	// A room belongs to one zone: listed twice, its zone would depend on the order of the file.
	for (const room of new Set(zones.flatMap((z) => z.rooms))) {
		const listing = zones.filter((z) => z.rooms.includes(room)).map((z) => z.id);
		if (listing.length > 1) errors.push(`${room} is listed by more than one zone (${listing.join(", ")})`);
	}
	return zones;
}

function parseRooms(value: unknown, zones: readonly LayoutZone[], errors: string[]): LayoutRoom[] {
	const rooms: LayoutRoom[] = [];
	for (const r of arrayOf(value)) {
		const rec = isRecord(r) ? r : {};
		const rect = rectOf(rec.rect);
		if (!isRoomCode(rec.room)) {
			errors.push(`unknown room ${String(rec.room)}`);
			continue;
		}
		const zone = zones.find((z) => z.rooms.includes(rec.room as RoomCode));
		if (rect === null) errors.push(`${rec.room} needs a rect [x0, z0, x1, z1]`);
		if (zone === undefined) {
			errors.push(`${rec.room} is in no zone`);
			continue;
		}
		if (rect !== null && !rectInside(rect, zone.rect)) errors.push(`${rec.room} reaches outside its zone ${zone.id}`);
		rooms.push({ room: rec.room, name: stringOf(rec.name), rect: rect ?? [0, 0, 0, 0], zone: zone.id });
	}
	return rooms;
}

function parseAnchors(value: unknown, errors: string[]): LayoutAnchor[] {
	const anchors: LayoutAnchor[] = [];
	const roomOrNull = (v: unknown): RoomCode | null => (isRoomCode(v) ? v : null);
	for (const a of arrayOf(value)) {
		const rec = isRecord(a) ? a : {};
		const kind = ANCHOR_KINDS.find((k) => k === rec.kind);
		const x = numberOf(rec.x);
		const z = numberOf(rec.z);
		const id = stringOf(rec.id);
		if (id === "" || kind === undefined || x === null || z === null) {
			errors.push(`anchor ${id || "(no id)"} needs an id, a known kind and x, z`);
			continue;
		}
		const act = GYM_ACTS.find((g) => g === rec.act) ?? null;
		if (kind === "gym" && act === null) errors.push(`gym anchor ${id} needs an act (${GYM_ACTS.join(", ")})`);
		anchors.push({
			id,
			kind,
			room: roomOrNull(rec.room),
			x,
			z,
			face: numberOf(rec.face) ?? 0,
			node: stringOf(rec.node),
			y: numberOf(rec.y) ?? 0,
			lie: rec.lie === true,
			sit: rec.sit === true,
			low: rec.low === true,
			act,
		});
	}
	return anchors;
}

function inside(rect: Rect, x: number, z: number): boolean {
	return x >= rect[0] && x <= rect[2] && z >= rect[1] && z <= rect[3];
}

/** What must hold of the plan for the views to work: every room has a door and a place to stand, every anchor sits in its room's zone, the walkways join everything. */
function checkPlan(layout: Omit<OfficeLayout, "formatVersion" | "camera">, errors: string[]): void {
	const nodeIds = new Set(layout.graph.nodes.map((n) => n.id));
	if (nodeIds.size !== layout.graph.nodes.length) errors.push("walkway node ids used twice");
	for (const [a, b] of layout.graph.edges) if (!nodeIds.has(a) || !nodeIds.has(b)) errors.push(`edge ${a} - ${b} uses an unknown node`);
	const entry = layout.anchors.find((a) => a.id === "lobby-entry");
	if (entry === undefined) errors.push("no lobby-entry anchor to start the walkway check from");
	for (const a of layout.anchors) {
		if (!nodeIds.has(a.node)) errors.push(`anchor ${a.id} points at unknown node ${a.node}`);
		if (a.room === null) continue;
		const room = layout.rooms.find((r) => r.room === a.room);
		const zone = layout.zones.find((z) => z.id === room?.zone);
		if (room === undefined || zone === undefined) errors.push(`anchor ${a.id} is in ${a.room}, which the plan does not have`);
		else if (!inside(zone.rect, a.x, a.z)) errors.push(`anchor ${a.id} stands outside ${zone.name} (zone ${zone.id}), the zone of ${a.room}`);
	}
	for (const r of layout.rooms) {
		if (!layout.doors.some((d) => d.between.includes(r.room))) errors.push(`${r.room} has no door`);
		if (!layout.anchors.some((a) => a.room === r.room && SPOT_KINDS.includes(a.kind))) errors.push(`${r.room} has no place to stand`);
	}
	if (entry === undefined || errors.length > 0) return;
	const walk = buildWalkGraph(layout.graph);
	const cut = layout.graph.nodes.filter((n) => !walk.reachable(entry.node).has(n.id)).map((n) => n.id);
	if (cut.length > 0) errors.push(`walkway graph is cut, ${cut.join(", ")} not reachable from the lobby entrance`);
	else {
		const longest = longestWalk(walk, [...new Set(layout.anchors.map((a) => a.node))]);
		if (longest.metres > MAX_WALK_METRES) errors.push(`the walk from ${longest.from} to ${longest.to} is ${longest.metres.toFixed(1)} m, more than ${MAX_WALK_METRES} m`);
	}
}

/** Reads and checks a layout file; `errors` say what is wrong, never a throw. */
export function parseOfficeLayout(json: unknown): Parsed<OfficeLayout> {
	if (!isRecord(json)) return { ok: false, errors: ["the layout is not a JSON object"] };
	if (json.formatVersion !== LAYOUT_FORMAT_VERSION) return { ok: false, errors: [`format version ${String(json.formatVersion)}, this app reads ${LAYOUT_FORMAT_VERSION}`] };
	const errors: string[] = [];
	const zones = parseZones(json.zones, errors);
	const rooms = parseRooms(json.rooms, zones, errors);
	for (const code of ROOM_CODES) {
		const count = rooms.filter((r) => r.room === code).length;
		if (count !== 1) errors.push(`${code} appears ${count} times, expected once`);
	}
	const anchors = parseAnchors(json.anchors, errors);
	const ids = anchors.map((a) => a.id);
	const repeated = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
	if (repeated.length > 0) errors.push(`anchor ids used twice: ${repeated.join(", ")}`);
	const desks = anchors.filter((a) => a.kind === "desk" && a.room === "WORK");
	if (desks.length !== LAYOUT_DESKS) errors.push(`WORK has ${desks.length} desks, expected ${LAYOUT_DESKS}`);
	const phoneDeskOrder = arrayOf(json.phoneDeskOrder).map(stringOf);
	if (phoneDeskOrder.length !== LAYOUT_PHONE_DESKS || new Set(phoneDeskOrder).size !== phoneDeskOrder.length || phoneDeskOrder.some((id) => !desks.some((d) => d.id === id))) {
		errors.push(`phoneDeskOrder must name ${LAYOUT_PHONE_DESKS} different desks of WORK`);
	}
	const graph = isRecord(json.graph) ? json.graph : {};
	const nodes = arrayOf(graph.nodes).flatMap((n): LayoutNode[] => {
		const rec = isRecord(n) ? n : {};
		const id = stringOf(rec.id);
		return id === "" ? [] : [{ id, x: numberOf(rec.x) ?? 0, z: numberOf(rec.z) ?? 0 }];
	});
	const edges = arrayOf(graph.edges).flatMap((e): (readonly [string, string])[] => {
		const pair = arrayOf(e).map(stringOf);
		return pair.length === 2 ? [[pair[0] ?? "", pair[1] ?? ""]] : [];
	});
	const doors = arrayOf(json.doors).map((d) => {
		const rec = isRecord(d) ? d : {};
		return { id: stringOf(rec.id), between: arrayOf(rec.between).map((v) => (isRoomCode(v) ? v : null)) };
	});
	const footprint = rectOf(json.footprint);
	if (footprint === null) errors.push("footprint needs [x0, z0, x1, z1]");
	const plan = { footprint: footprint ?? ([0, 0, 0, 0] as const), zones, rooms, doors, anchors, phoneDeskOrder, graph: { nodes, edges } };
	checkPlan(plan, errors);
	const camera = parseCamera(json.defaultCamera, errors);
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, value: { formatVersion: LAYOUT_FORMAT_VERSION, ...plan, camera } };
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
