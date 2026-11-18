// Which person's name tag a press on the 3D canvas landed on. The tags are
// buttons (so the keyboard and screen readers reach them) that take no pointer:
// a press goes to the canvas, whose camera tells a tap from a drag
// (scene/office-camera.ts), and then this finds the tag under it. A tag, and
// above all the status dot an idle person shrinks to when zoomed far out, is a
// small target: its box is widened to MIN_TARGET_PX each way for the press.
// Pure: boxes in, a key out.

/** The smallest box a press can land on, CSS px (the size of a finger tip). */
export const MIN_TARGET_PX = 32;

export interface TagBox {
	readonly key: string;
	readonly left: number;
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
}

function widened(box: TagBox): TagBox {
	const growX = Math.max(0, MIN_TARGET_PX - (box.right - box.left)) / 2;
	const growY = Math.max(0, MIN_TARGET_PX - (box.bottom - box.top)) / 2;
	return { ...box, left: box.left - growX, right: box.right + growX, top: box.top - growY, bottom: box.bottom + growY };
}

/** The key of the tag whose (widened) box holds the point; of several, the one whose centre is nearest; null for none. */
export function tagAt(boxes: readonly TagBox[], x: number, y: number): string | null {
	let best: { readonly key: string; readonly distance: number } | null = null;
	for (const box of boxes) {
		const w = widened(box);
		if (x < w.left || x > w.right || y < w.top || y > w.bottom) continue;
		const distance = Math.hypot(x - (box.left + box.right) / 2, y - (box.top + box.bottom) / 2);
		if (best === null || distance < best.distance) best = { key: box.key, distance };
	}
	return best?.key ?? null;
}
