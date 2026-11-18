// Where a placed person stands or sits in the 3D office: the anchor of
// their placement (or of the idle show), its position, facing and
// walkway node, whether they sit there (desks, the director's chair, the
// meeting table, the sofa, the living rooms' seats), how high they stand or
// lie there (a bed, a treadmill) and how high the seat under them is (the anchor's, from its furniture), and a sideways step for someone sharing an anchor
// with others (a full room: the placement lets people share places) or
// standing beside a desk on the director's round. Pure, no engine.
import type { OfficeLayout } from "../../machines/office/office-layout.ts";

export interface PersonTarget {
	readonly anchorId: string;
	readonly x: number;
	readonly z: number;
	/** Babylon rotation.y they face once there. */
	readonly face: number;
	readonly node: string;
	readonly seated: boolean;
	/** Height of the feet (or of a lying body's back) over the floor once there, metres. */
	readonly y: number;
	/** Where the sitter's seat rests when seated there (the cushion less its sink), metres over the floor. */
	readonly seat: number;
	/** A low seat (a beanbag). */
	readonly low: boolean;
	/** Seated at a desk with a keyboard (types there). */
	readonly keyboard: boolean;
	/** Seated at a work or meeting seat without a keyboard (the meeting table, the reading table, Advisor's visitors' chairs): talks there. */
	readonly talkSeat: boolean;
}

/** Seats where people talk instead of typing when they have no keyboard; the director's chair and the living rooms' are not. */
const TALK_SEAT_KINDS: ReadonlySet<string> = new Set(["meeting", "work"]);

const SEAT_KINDS: ReadonlySet<string> = new Set(["desk", "director", "meeting", "sofa"]);
/** Sideways step between people sharing one anchor, metres. */
export const SHARE_STEP = 0.6;
/** How far beside a desk the director stands on the round. */
export const BESIDE_STEP = 0.85;

/**
 * `share`: 0 for the first person at the anchor, 1, 2, … for the others
 * (alternating right and left). `beside`: stand next to it facing it.
 */
export function personTarget(layout: OfficeLayout, anchorId: string, share: number, beside: boolean): PersonTarget | null {
	const a = layout.anchors.find((anchor) => anchor.id === anchorId);
	if (a === undefined) return null;
	// The right hand of someone facing `face` (rotation.y) in Babylon's left-handed frame.
	const rightX = Math.cos(a.face);
	const rightZ = -Math.sin(a.face);
	if (beside) {
		return { anchorId, x: a.x + rightX * BESIDE_STEP, z: a.z + rightZ * BESIDE_STEP, face: a.face - Math.PI / 2, node: a.node, seated: false, y: 0, seat: a.seat, low: false, keyboard: false, talkSeat: false };
	}
	const steps = share <= 0 ? 0 : Math.ceil(share / 2) * (share % 2 === 1 ? 1 : -1);
	return {
		anchorId,
		x: a.x + rightX * SHARE_STEP * steps,
		z: a.z + rightZ * SHARE_STEP * steps,
		face: a.face,
		node: a.node,
		seated: share <= 0 && (SEAT_KINDS.has(a.kind) || a.sit),
		// Only the first at an anchor is on the bed or the treadmill; the others stand beside it.
		y: share <= 0 ? a.y : 0,
		seat: a.seat,
		low: share <= 0 && a.low,
		keyboard: share <= 0 && a.keyboard,
		talkSeat: share <= 0 && a.sit && !a.keyboard && TALK_SEAT_KINDS.has(a.kind),
	};
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

/** The walkway node nearest a point of the plan (to rejoin the graph from anywhere). */
export function nearestNode(layout: OfficeLayout, x: number, z: number): string | null {
	let best: string | null = null;
	let bestD = Infinity;
	for (const n of layout.graph.nodes) {
		const d = Math.hypot(n.x - x, n.z - z);
		if (d < bestD) {
			bestD = d;
			best = n.id;
		}
	}
	return best;
}
