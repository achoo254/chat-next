// Where a placed person stands or sits in the 3D building: the anchor of
// their placement (or of the idle show), its floor, position, facing and
// walkway node, whether they sit there (desks, the director's chair, the
// meeting table, the sofa, the living floor's seats), how high they stand or
// lie there (a bed, a treadmill) and how low they sit, and a sideways step for someone sharing an anchor
// with others (a full room: the placement lets people share places) or
// standing beside a desk on the director's round. Pure, no engine.
import type { OfficeLayout } from "../../machines/office/office-layout.ts";
import type { FloorLevel } from "../../machines/office/office-rooms.ts";

export interface PersonTarget {
	readonly anchorId: string;
	readonly floor: FloorLevel;
	readonly x: number;
	readonly z: number;
	/** Babylon rotation.y they face once there. */
	readonly face: number;
	readonly node: string;
	readonly seated: boolean;
	/** Height of the feet (or of a lying body's back) over the floor once there, metres. */
	readonly y: number;
	/** Where the pelvis rests when seated there, metres over the floor. */
	readonly seat: number;
	/** A low seat (a beanbag). */
	readonly low: boolean;
}

const SEAT_KINDS: ReadonlySet<string> = new Set(["desk", "director", "meeting", "sofa"]);
/** Sideways step between people sharing one anchor, metres. */
export const SHARE_STEP = 0.6;
/** How far beside a desk the director stands on the round. */
export const BESIDE_STEP = 0.85;
/** Pelvis height on a chair or sofa, and on a beanbag, metres. */
export const SEAT_HEIGHT = 0.5;
export const LOW_SEAT_HEIGHT = 0.26;

/**
 * `share`: 0 for the first person at the anchor, 1, 2, … for the others
 * (alternating right and left). `beside`: stand next to it facing it.
 */
export function personTarget(layout: OfficeLayout, anchorId: string, share: number, beside: boolean): PersonTarget | null {
	for (const floor of layout.floors) {
		const a = floor.anchors.find((anchor) => anchor.id === anchorId);
		if (a === undefined) continue;
		// The right hand of someone facing `face` (rotation.y) in Babylon's left-handed frame.
		const rightX = Math.cos(a.face);
		const rightZ = -Math.sin(a.face);
		if (beside) {
			return { anchorId, floor: floor.level, x: a.x + rightX * BESIDE_STEP, z: a.z + rightZ * BESIDE_STEP, face: a.face - Math.PI / 2, node: a.node, seated: false, y: 0, seat: SEAT_HEIGHT, low: false };
		}
		const steps = share <= 0 ? 0 : Math.ceil(share / 2) * (share % 2 === 1 ? 1 : -1);
		return {
			anchorId,
			floor: floor.level,
			x: a.x + rightX * SHARE_STEP * steps,
			z: a.z + rightZ * SHARE_STEP * steps,
			face: a.face,
			node: a.node,
			seated: share <= 0 && (SEAT_KINDS.has(a.kind) || a.sit),
			// Only the first at an anchor is on the bed or the treadmill; the others stand beside it.
			y: share <= 0 ? a.y : 0,
			seat: a.low ? LOW_SEAT_HEIGHT : SEAT_HEIGHT,
			low: share <= 0 && a.low,
		};
	}
	return null;
}

/** For people in order wanting anchors, each one's place in the queue at their anchor. */
export function shareIndices(anchorIds: readonly string[]): number[] {
	const seen = new Map<string, number>();
	return anchorIds.map((id) => {
		const n = seen.get(id) ?? 0;
		seen.set(id, n + 1);
		return n;
	});
}

/** The walkway node nearest a point of a floor (to rejoin the graph from anywhere). */
export function nearestNode(layout: OfficeLayout, floor: FloorLevel, x: number, z: number): string | null {
	const f = layout.floors.find((fl) => fl.level === floor);
	let best: string | null = null;
	let bestD = Infinity;
	for (const n of f?.graph.nodes ?? []) {
		const d = Math.hypot(n.x - x, n.z - z);
		if (d < bestD) {
			bestD = d;
			best = n.id;
		}
	}
	return best;
}
