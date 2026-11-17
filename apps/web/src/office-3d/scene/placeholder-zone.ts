// One zone of the plan in placeholder blocks, straight from the layout: the
// slab of each room and walkway, the tall outer walls where the zone meets
// the plan's back or right edge, inner walls, the low walls between zones and
// the glass runs with the doorways cut out, and the decor the bake builds
// (rugs, dividers, boards, art, clocks). Each piece goes to the zone its
// middle lies in (the nearest zone for the corridors between them), so the
// four zones together draw the plan once. Furniture and small props are built
// per name elsewhere (prop-library.ts). Everything hangs under one node so the
// zone's baked shell replaces it in one go.
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { LayoutZone, ZoneId } from "../../machines/office/office-layout.ts";
import type { BlockKit } from "./block-kit.ts";
import { CORE_COLOR, FRAME_COLOR, GLASS_COLOR, ROOM_TONES, RUG_TONES, WALL_COLOR } from "./placeholder-shapes.ts";
import { segmentsMinusDoors, type Decor, type Rect, type SceneLayout, type Segment } from "./scene-layout.ts";

const SLAB = 0.12;
const WALL_T = 0.2;
const GLASS_T = 0.05;
const GLASS_H = 2.3;
const INNER_WALL_H = 2.3;

/** The zones as the placeholder needs them: an id and a rectangle of the plan. */
export type ZoneRect = Pick<LayoutZone, "id" | "rect">;

function distanceToRect(r: Rect, x: number, z: number): number {
	const dx = Math.max(r[0] - x, 0, x - r[2]);
	const dz = Math.max(r[1] - z, 0, z - r[3]);
	return Math.hypot(dx, dz);
}

/** The zone a point of the plan belongs to: the first holding it, else the nearest (null without zones). */
export function zoneOfPoint(zones: readonly ZoneRect[], x: number, z: number): ZoneId | null {
	let best: ZoneRect | null = null;
	let bestD = Infinity;
	for (const zone of zones) {
		const d = distanceToRect(zone.rect, x, z);
		if (d < bestD) {
			bestD = d;
			best = zone;
		}
	}
	return best?.id ?? null;
}

/**
 * Where the tall outer walls of a zone run: along the plan's back edge over
 * the zone's width, and along its right edge over the zone's depth, each
 * carried on to the next zone along the edge (or the plan's corner) so the
 * gaps of the corridors between zones are walled too.
 */
export function outerWallRuns(zone: ZoneRect, zones: readonly ZoneRect[], footprint: Rect): Segment[] {
	const [fx0, fz0, fx1, fz1] = footprint;
	const [x0, z0, x1, z1] = zone.rect;
	const EPS = 1e-6;
	const runs: Segment[] = [];
	if (Math.abs(z1 - fz1) < EPS) {
		const next = zones.filter((o) => Math.abs(o.rect[3] - fz1) < EPS && o.rect[0] >= x1 - EPS && o.id !== zone.id).map((o) => o.rect[0]);
		const start = Math.abs(x0 - fx0) < EPS ? fx0 : x0;
		runs.push([start, fz1, next.length > 0 ? Math.min(...next) : fx1, fz1]);
	}
	if (Math.abs(x1 - fx1) < EPS) {
		const next = zones.filter((o) => Math.abs(o.rect[2] - fx1) < EPS && o.rect[1] >= z1 - EPS && o.id !== zone.id).map((o) => o.rect[1]);
		const start = Math.abs(z0 - fz0) < EPS ? fz0 : z0;
		runs.push([fx1, start, fx1, next.length > 0 ? Math.min(...next) : fz1]);
	}
	return runs;
}

function segmentBlock(kit: BlockKit, parent: TransformNode, name: string, seg: Segment, y: number, h: number, t: number, color: string, look: "solid" | "glass" = "solid"): void {
	const [x0, z0, x1, z1] = seg;
	const length = Math.hypot(x1 - x0, z1 - z0);
	if (length < 0.01) return;
	kit.block(parent, name, { x: (x0 + x1) / 2, y, z: (z0 + z1) / 2, w: length, h, d: t, rotY: -Math.atan2(z1 - z0, x1 - x0), color, look });
}

/** Where a decor piece stands on the plan (its zone is the one holding this point). */
function decorPoint(layout: SceneLayout, d: Decor): readonly [number, number] {
	const [, , fx1, fz1] = layout.footprint;
	if (d.rect !== null) return [(d.rect[0] + d.rect[2]) / 2, (d.rect[1] + d.rect[3]) / 2];
	if (d.wall === "back") return [d.num.x ?? 0, fz1];
	if (d.wall === "east") return [fx1, d.num.z ?? 0];
	return [d.num.x ?? 0, d.num.z ?? 0];
}

/** A flat thing: on the back (z max) or right (x max) outer wall, or standing free in a room turned by `num.face`. */
function flatPiece(kit: BlockKit, parent: TransformNode, layout: SceneLayout, d: Decor, i: number, color: string): void {
	const [, , fx1, fz1] = layout.footprint;
	const w = d.num.width ?? d.num.size ?? 0.6;
	const h = d.num.height ?? d.num.size ?? 0.5;
	const y = (d.num.y ?? 1.6) - h / 2;
	const name = `decor-${d.kind}-${i}`;
	if (d.wall === "east") kit.block(parent, name, { x: fx1 - WALL_T / 2 - 0.04, y, z: d.num.z ?? 0, w: 0.04, h, d: w, color });
	else if (d.wall === "back") kit.block(parent, name, { x: d.num.x ?? 0, y, z: fz1 - WALL_T / 2 - 0.04, w, h, d: 0.04, color });
	else kit.block(parent, name, { x: d.num.x ?? 0, y, z: d.num.z ?? 0, w, h, d: 0.04, rotY: d.num.face ?? 0, color });
}

function buildDecor(kit: BlockKit, parent: TransformNode, layout: SceneLayout, decor: readonly (readonly [Decor, number])[]): void {
	for (const [d, i] of decor) {
		const r = d.rect;
		switch (d.kind) {
			case "rug":
				if (r !== null) kit.block(parent, `rug-${i}`, { x: (r[0] + r[2]) / 2, y: 0, z: (r[1] + r[3]) / 2, w: Math.abs(r[2] - r[0]), h: 0.015, d: Math.abs(r[3] - r[1]), color: RUG_TONES[d.colour] ?? "#a99ad1" });
				break;
			case "divider": {
				const w = d.num.width ?? 2;
				const alongX = d.axis !== "z";
				kit.block(parent, `divider-${i}`, { x: d.num.x ?? 0, y: d.num.y ?? 0.75, z: d.num.z ?? 0, w: alongX ? w : 0.04, h: d.num.height ?? 0.5, d: alongX ? 0.04 : w, color: "#b9b0d6" });
				break;
			}
			case "board":
				flatPiece(kit, parent, layout, d, i, "#f6f3ea");
				break;
			case "art":
				flatPiece(kit, parent, layout, d, i, ["#e8a87c", "#7fb3d5", "#c39bd3"][i % 3] ?? "#e8a87c");
				break;
			case "clock":
				flatPiece(kit, parent, layout, d, i, "#fbfaf6");
				break;
			default:
				break;
		}
	}
}

/** The zone's shell in blocks under a new node below `parent`. */
export function buildPlaceholderZone(scene: Scene, kit: BlockKit, layout: SceneLayout, zone: ZoneRect, zones: readonly ZoneRect[], parent: TransformNode): TransformNode {
	const shell = new TransformNode(`zone-blocks-${zone.id}`, scene);
	shell.parent = parent;
	const mine = (x: number, z: number): boolean => zoneOfPoint(zones, x, z) === zone.id;
	const mid = (s: Segment): readonly [number, number] => [(s[0] + s[2]) / 2, (s[1] + s[3]) / 2];
	for (const room of layout.rooms) {
		const [x0, z0, x1, z1] = room.rect;
		if (!mine((x0 + x1) / 2, (z0 + z1) / 2)) continue;
		kit.block(shell, `slab-${room.room}`, { x: (x0 + x1) / 2, y: -SLAB, z: (z0 + z1) / 2, w: x1 - x0, h: SLAB, d: z1 - z0, color: ROOM_TONES[room.room] ?? "#d6b48c" });
	}
	layout.circulation.forEach(([x0, z0, x1, z1], i) => {
		if (!mine((x0 + x1) / 2, (z0 + z1) / 2)) return;
		kit.block(shell, `slab-hall-${i}`, { x: (x0 + x1) / 2, y: -SLAB - 0.01, z: (z0 + z1) / 2, w: x1 - x0, h: SLAB, d: z1 - z0, color: "#d9d4dc" });
	});
	const h = layout.wallHeight;
	outerWallRuns(zone, zones, layout.footprint).forEach(([x0, z0, x1, z1], i) => {
		// The back wall sits just behind the plan's edge, the right one just beyond it; the back one covers the corner.
		const back = Math.abs(z0 - z1) < 1e-6;
		const seg: Segment = back ? [x0, z0 + WALL_T / 2, x1 + (x1 >= layout.footprint[2] ? WALL_T : 0), z1 + WALL_T / 2] : [x0 + WALL_T / 2, z0, x1 + WALL_T / 2, z1];
		segmentBlock(kit, shell, `wall-outer-${i}`, seg, -SLAB, h + SLAB, WALL_T, WALL_COLOR);
	});
	layout.walls.forEach((seg, i) => {
		const [x, z] = mid(seg);
		if (mine(x, z)) segmentsMinusDoors(seg, layout.doors).forEach((piece, j) => segmentBlock(kit, shell, `wall-${i}-${j}`, piece, 0, INNER_WALL_H, WALL_T, CORE_COLOR));
	});
	layout.lowWalls.forEach((seg, i) => {
		const [x, z] = mid(seg);
		if (mine(x, z)) segmentsMinusDoors(seg, layout.doors).forEach((piece, j) => segmentBlock(kit, shell, `low-wall-${i}-${j}`, piece, 0, layout.lowWallHeight, WALL_T, CORE_COLOR));
	});
	layout.glass.forEach((seg, i) => {
		const [x, z] = mid(seg);
		if (!mine(x, z)) return;
		segmentsMinusDoors(seg, layout.doors).forEach((piece, j) => {
			segmentBlock(kit, shell, `glass-frame-${i}-${j}`, piece, 0, 0.08, GLASS_T * 2, FRAME_COLOR);
			segmentBlock(kit, shell, `glass-${i}-${j}`, piece, 0.08, GLASS_H - 0.08, GLASS_T, GLASS_COLOR, "glass");
		});
	});
	const decor = layout.decor.map((d, i) => [d, i] as const).filter(([d]) => {
		const [x, z] = decorPoint(layout, d);
		return mine(x, z);
	});
	buildDecor(kit, shell, layout, decor);
	return shell;
}
