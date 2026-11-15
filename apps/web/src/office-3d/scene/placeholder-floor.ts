// One floor of the building in placeholder blocks, straight from the layout:
// the slab of each room and walkway, the outer back and right walls with
// their windows, inner walls, glass runs with the doorways cut out, and the
// decor the bake builds (elevator, stairs, rugs, dividers, wall boards and
// art). Furniture and small props are built per name (prop-library.ts swaps
// a name for its model when it arrives). Everything hangs under `shell` so a
// baked shell model replaces it in one go.
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { BlockKit } from "./block-kit.ts";
import { CORE_COLOR, FRAME_COLOR, GLASS_COLOR, METAL_COLOR, ROOM_TONES, RUG_TONES, WALL_COLOR } from "./placeholder-shapes.ts";
import { segmentsMinusDoors, type Decor, type SceneFloor, type SceneLayout, type Segment } from "./scene-layout.ts";

const SLAB = 0.12;
const WALL_T = 0.2;
const GLASS_T = 0.05;
const GLASS_H = 2.3;
const INNER_WALL_H = 2.3;

function segmentBlock(kit: BlockKit, parent: TransformNode, name: string, seg: Segment, y: number, h: number, t: number, color: string, look: "solid" | "glass" = "solid"): void {
	const [x0, z0, x1, z1] = seg;
	const length = Math.hypot(x1 - x0, z1 - z0);
	if (length < 0.01) return;
	kit.block(parent, name, { x: (x0 + x1) / 2, y, z: (z0 + z1) / 2, w: length, h, d: t, rotY: -Math.atan2(z1 - z0, x1 - x0), color, look });
}

/** A flat thing on the back (z max) or right (x max) wall: art, a board, a clock. */
function wallPiece(kit: BlockKit, parent: TransformNode, layout: SceneLayout, d: Decor, i: number, color: string): void {
	const [, , fx1, fz1] = layout.footprint;
	const w = d.num.width ?? d.num.size ?? 0.6;
	const h = d.num.height ?? d.num.size ?? 0.5;
	const y = (d.num.y ?? 1.6) - h / 2;
	if (d.wall === "east") kit.block(parent, `wall-${d.kind}-${i}`, { x: fx1 - WALL_T / 2 - 0.04, y, z: d.num.z ?? 0, w: 0.04, h, d: w, color });
	else kit.block(parent, `wall-${d.kind}-${i}`, { x: d.num.x ?? 0, y, z: fz1 - WALL_T / 2 - 0.04, w, h, d: 0.04, color });
}

function buildDecor(kit: BlockKit, parent: TransformNode, layout: SceneLayout, floor: SceneFloor): void {
	floor.decor.forEach((d, i) => {
		const r = d.rect;
		switch (d.kind) {
			case "elevator":
				kit.block(parent, `elevator-${i}`, { x: d.num.x ?? 0, y: 0, z: d.num.z ?? 0, w: d.num.width ?? 1.7, h: 2.4, d: d.num.depth ?? 2.4, color: METAL_COLOR });
				break;
			case "stairs":
				if (r !== null) {
					const steps = 5;
					const west = r[0] < r[2];
					for (let s = 0; s < steps; s += 1) {
						const f0 = s / steps;
						const x0 = west ? r[0] + (r[2] - r[0]) * f0 : r[0];
						kit.block(parent, `stair-${i}-${s}`, { x: (x0 + r[2]) / 2, y: 0, z: (r[1] + r[3]) / 2, w: Math.abs(r[2] - x0), h: 0.18 * (steps - s), d: Math.abs(r[3] - r[1]), color: CORE_COLOR });
					}
				}
				break;
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
				wallPiece(kit, parent, layout, d, i, "#f6f3ea");
				break;
			case "art":
				wallPiece(kit, parent, layout, d, i, ["#e8a87c", "#7fb3d5", "#c39bd3"][i % 3] ?? "#e8a87c");
				break;
			case "clock":
				wallPiece(kit, parent, layout, d, i, "#fbfaf6");
				break;
			default:
				break;
		}
	});
}

/** The floor's shell in blocks under a new node (disabled until shown). */
export function buildPlaceholderShell(scene: Scene, kit: BlockKit, layout: SceneLayout, floor: SceneFloor, parent: TransformNode): TransformNode {
	const shell = new TransformNode(`shell-blocks-${floor.level}`, scene);
	shell.parent = parent;
	for (const room of floor.rooms) {
		const [x0, z0, x1, z1] = room.rect;
		kit.block(shell, `slab-${room.room}`, { x: (x0 + x1) / 2, y: -SLAB, z: (z0 + z1) / 2, w: x1 - x0, h: SLAB, d: z1 - z0, color: ROOM_TONES[room.room] ?? "#d6b48c" });
	}
	floor.circulation.forEach(([x0, z0, x1, z1], i) => {
		kit.block(shell, `slab-hall-${i}`, { x: (x0 + x1) / 2, y: -SLAB - 0.01, z: (z0 + z1) / 2, w: x1 - x0, h: SLAB, d: z1 - z0, color: "#d9d4dc" });
	});
	const [fx0, fz0, fx1, fz1] = layout.footprint;
	const h = layout.wallHeight;
	// Outer walls only at the back and the right; the front and left stay open for the camera.
	segmentBlock(kit, shell, "wall-back", [fx0, fz1 + WALL_T / 2, fx1 + WALL_T, fz1 + WALL_T / 2], -SLAB, h + SLAB, WALL_T, WALL_COLOR);
	segmentBlock(kit, shell, "wall-east", [fx1 + WALL_T / 2, fz0, fx1 + WALL_T / 2, fz1], -SLAB, h + SLAB, WALL_T, WALL_COLOR);
	floor.walls.forEach((seg, i) => segmentsMinusDoors(seg, floor.doors).forEach((piece, j) => segmentBlock(kit, shell, `wall-${i}-${j}`, piece, 0, INNER_WALL_H, WALL_T, CORE_COLOR)));
	floor.glass.forEach((seg, i) =>
		segmentsMinusDoors(seg, floor.doors).forEach((piece, j) => {
			segmentBlock(kit, shell, `glass-frame-${i}-${j}`, piece, 0, 0.08, GLASS_T * 2, FRAME_COLOR);
			segmentBlock(kit, shell, `glass-${i}-${j}`, piece, 0.08, GLASS_H - 0.08, GLASS_T, GLASS_COLOR, "glass");
		}),
	);
	buildDecor(kit, shell, layout, floor);
	return shell;
}
