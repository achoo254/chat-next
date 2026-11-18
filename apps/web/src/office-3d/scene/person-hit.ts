// Which person's body a tap on the 3D canvas landed on. Every person is a
// screen-space capsule from their feet up to the height of their name label: the
// characters are skinned meshes (picked by their standing pose, wrong for
// someone sitting or lying), none of them is pickable, and a robot is no
// character at all, so the scene is not asked to pick. The camera looks from
// the front over the plan, so the tall walls stand behind everyone and nothing
// needs to block the pick. Pure: projected points in, a key out.

/** The narrowest half width of a body on screen, CSS px (someone far away is still a target). */
export const BODY_MIN_HALF_WIDTH_PX = 14;
/** A body's half width as a share of its height on screen. */
export const BODY_HALF_WIDTH_RATIO = 0.3;
/** Slack above the head and below the feet, CSS px. */
export const BODY_PAD_PX = 6;

/** A person's feet and head projected on the page (CSS px). */
export interface ProjectedBody {
	readonly key: string;
	readonly footX: number;
	readonly footY: number;
	readonly headY: number;
}

/** The person whose body holds the point; of several, the nearest to the camera (the lowest feet on screen); null for none. */
export function bodyAt(bodies: readonly ProjectedBody[], x: number, y: number): string | null {
	let best: ProjectedBody | null = null;
	for (const body of bodies) {
		const height = Math.max(0, body.footY - body.headY);
		const half = Math.max(BODY_MIN_HALF_WIDTH_PX, height * BODY_HALF_WIDTH_RATIO);
		const inside = Math.abs(x - body.footX) <= half && y >= body.headY - BODY_PAD_PX && y <= body.footY + BODY_PAD_PX;
		if (inside && (best === null || body.footY > best.footY)) best = body;
	}
	return best?.key ?? null;
}
