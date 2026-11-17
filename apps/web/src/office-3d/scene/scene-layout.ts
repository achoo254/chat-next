// The parts of office-layout.json only the 3D scene draws, for the whole
// plan: the footprint, the wall heights (tall outer walls, low walls between
// zones), the rooms, walkways, glass, walls, low walls, windows, doors with
// their openings, furniture and small props (instanced by name) and the decor
// the Blender bake builds (rugs, boards, art). office-layout.ts (shared with
// the 2D view) checks the rest; this reader never throws: a missing or odd
// field reads as empty, so a newer layout cannot break the scene. Pure, no
// engine.
import { OFFICE_LAYOUT_TEXT } from "../../machines/office/office-layout.ts";
import { arrayOf, isRecord, numberOf, stringOf } from "../../machines/office/office-json.ts";
import type { RoomCode } from "../../machines/office/office-rooms.ts";
import { isRoomCode } from "../../machines/office/office-rooms.ts";

export type Rect = readonly [number, number, number, number];
/** A straight wall or glass run on the floor, [x0, z0, x1, z1]. */
export type Segment = readonly [number, number, number, number];

export interface Door {
	readonly id: string;
	readonly at: readonly [number, number];
	readonly width: number;
	/** The axis the doorway's opening runs along. */
	readonly axis: "x" | "z";
}

export interface Place {
	readonly name: string;
	readonly x: number;
	readonly z: number;
	readonly y: number;
	readonly rotY: number;
	/** The desk anchor a prop belongs to (screens glow while that desk works). */
	readonly anchor: string;
}

/**
 * Decor as the layout lists it: a kind and its numbers (the scene picks what
 * it draws). `wall` names the outer wall it hangs on ("back", "east"), or
 * "free" for a board standing in the room, turned by `num.face`.
 */
export interface Decor {
	readonly kind: string;
	readonly wall: string;
	readonly colour: string;
	readonly axis: string;
	readonly rect: Rect | null;
	readonly num: Readonly<Record<string, number>>;
}

/** A window in an outer wall: the wall, its span along it and its sill and top heights, metres. */
export interface SceneWindow {
	readonly wall: string;
	readonly from: number;
	readonly to: number;
	readonly sill: number;
	readonly top: number;
}

export interface SceneLayout {
	/** The whole plan [x0, z0, x1, z1]. */
	readonly footprint: Rect;
	readonly wallHeight: number;
	/** Height of the low walls between zones. */
	readonly lowWallHeight: number;
	readonly rooms: readonly { readonly room: RoomCode; readonly rect: Rect }[];
	readonly circulation: readonly Rect[];
	readonly glass: readonly Segment[];
	readonly walls: readonly Segment[];
	readonly lowWalls: readonly Segment[];
	readonly windows: readonly SceneWindow[];
	readonly doors: readonly Door[];
	readonly props: readonly Place[];
	readonly smallProps: readonly Place[];
	readonly decor: readonly Decor[];
}

const DEFAULT_FOOTPRINT: Rect = [-9, -9, 9, 5];
const DEFAULT_WALL_HEIGHT = 3;
const DEFAULT_LOW_WALL_HEIGHT = 1.1;

function rectOf(value: unknown): Rect | null {
	const n = arrayOf(value).map(numberOf);
	const [a, b, c, d] = n;
	if (n.length !== 4 || a == null || b == null || c == null || d == null) return null;
	return [a, b, c, d];
}

function placeOf(value: unknown): Place | null {
	if (!isRecord(value)) return null;
	const x = numberOf(value.x);
	const z = numberOf(value.z);
	const name = stringOf(value.name);
	if (x === null || z === null || name === "") return null;
	return { name, x, z, y: numberOf(value.y) ?? 0, rotY: numberOf(value.rotY) ?? 0, anchor: stringOf(value.anchor) };
}

function decorOf(value: unknown): Decor | null {
	if (!isRecord(value) || stringOf(value.kind) === "") return null;
	const num: Record<string, number> = {};
	for (const [key, v] of Object.entries(value)) {
		const n = numberOf(v);
		if (n !== null) num[key] = n;
	}
	return { kind: stringOf(value.kind), wall: stringOf(value.wall), colour: stringOf(value.colour), axis: stringOf(value.axis), rect: rectOf(value.rect), num };
}

function windowOf(value: unknown): SceneWindow | null {
	if (!isRecord(value)) return null;
	const from = numberOf(value.from);
	const to = numberOf(value.to);
	const sill = numberOf(value.sill);
	const top = numberOf(value.top);
	if (from === null || to === null || sill === null || top === null) return null;
	return { wall: stringOf(value.wall), from, to, sill, top };
}

/** A list of segments; rects are arrays themselves, so map then drop the misses (flatMap would flatten them). */
function segmentsOf(value: unknown): Segment[] {
	return arrayOf(value)
		.map(rectOf)
		.filter((r): r is Segment => r !== null);
}

export function parseSceneLayout(json: unknown): SceneLayout {
	const root = isRecord(json) ? json : {};
	const rooms = arrayOf(root.rooms).flatMap((r) => {
		if (!isRecord(r) || !isRoomCode(r.room)) return [];
		const rect = rectOf(r.rect);
		return rect === null ? [] : [{ room: r.room, rect }];
	});
	const doors = arrayOf(root.doors).flatMap((d): Door[] => {
		if (!isRecord(d)) return [];
		const at = arrayOf(d.at).map(numberOf);
		const x = at[0];
		const z = at[1];
		const width = numberOf(d.width);
		if (x == null || z == null || width === null) return [];
		return [{ id: stringOf(d.id), at: [x, z], width, axis: d.axis === "z" ? "z" : "x" }];
	});
	return {
		footprint: rectOf(root.footprint) ?? DEFAULT_FOOTPRINT,
		wallHeight: numberOf(root.wallHeight) ?? DEFAULT_WALL_HEIGHT,
		lowWallHeight: numberOf(root.lowWallHeight) ?? DEFAULT_LOW_WALL_HEIGHT,
		rooms,
		circulation: arrayOf(root.circulation)
			.map((c) => (isRecord(c) ? rectOf(c.rect) : null))
			.filter((r): r is Rect => r !== null),
		glass: segmentsOf(root.glass),
		walls: segmentsOf(root.walls),
		lowWalls: segmentsOf(root.lowWalls),
		windows: arrayOf(root.windows).flatMap((w) => windowOf(w) ?? []),
		doors,
		props: arrayOf(root.props).flatMap((p) => placeOf(p) ?? []),
		smallProps: arrayOf(root.smallProps).flatMap((p) => placeOf(p) ?? []),
		decor: arrayOf(root.decor).flatMap((d) => decorOf(d) ?? []),
	};
}

function readShipped(): SceneLayout {
	try {
		return parseSceneLayout(JSON.parse(OFFICE_LAYOUT_TEXT));
	} catch {
		return parseSceneLayout(null);
	}
}

/** The shipped layout's scene parts. */
export const SCENE_LAYOUT: SceneLayout = readShipped();

const EPS = 1e-6;

/**
 * A wall or glass run with the doorways on it cut out: the pieces left, in
 * order along the run. A door counts when it lies on the run's line and its
 * opening runs the same way.
 */
export function segmentsMinusDoors(seg: Segment, doors: readonly Door[]): Segment[] {
	const [x0, z0, x1, z1] = seg;
	const alongX = Math.abs(z1 - z0) < EPS;
	const alongZ = Math.abs(x1 - x0) < EPS;
	if (!alongX && !alongZ) return [seg];
	const lo = alongX ? Math.min(x0, x1) : Math.min(z0, z1);
	const hi = alongX ? Math.max(x0, x1) : Math.max(z0, z1);
	const cuts = doors
		.filter((d) => (alongX ? d.axis === "x" && Math.abs(d.at[1] - z0) < 0.05 : d.axis === "z" && Math.abs(d.at[0] - x0) < 0.05))
		.map((d) => {
			const c = alongX ? d.at[0] : d.at[1];
			return [c - d.width / 2, c + d.width / 2] as const;
		})
		.filter(([a, b]) => b > lo && a < hi)
		.sort((a, b) => a[0] - b[0]);
	const pieces: Segment[] = [];
	let from = lo;
	for (const [a, b] of cuts) {
		if (a - from > EPS) pieces.push(alongX ? [from, z0, a, z0] : [x0, from, x0, a]);
		from = Math.max(from, b);
	}
	if (hi - from > EPS) pieces.push(alongX ? [from, z0, hi, z0] : [x0, from, x0, hi]);
	return pieces;
}
