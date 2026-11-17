// Level of detail by zoom: zoomed out past a metre of plan per
// FAR_PIXELS_PER_METRE CSS pixels, the small props (mugs, papers, sticky
// notes, desk plants, book stacks) hide and idle people's labels shrink to
// their status dot; people at work keep their name and speech bubble. The
// threshold was measured on the merged plan: the phone's and the desktop's
// `work` framings (about 40 px a metre) keep everything, the whole
// plan on a desktop (about 20) and two zones on a phone (about 12) drop it.
// Coming back needs a little more zoom than going (a band) so a pinch resting
// at the threshold does not flicker. Pure, no engine.

/** Below this many CSS pixels a metre the view counts as far. */
export const FAR_PIXELS_PER_METRE = 25;
/** A far view turns near again only above this. */
export const NEAR_PIXELS_PER_METRE = 28;

/** Whether the view is far now, from whether it was and the pixels a metre takes. */
export function nextFar(wasFar: boolean, pixelsPerMetre: number): boolean {
	if (!Number.isFinite(pixelsPerMetre)) return wasFar;
	return wasFar ? pixelsPerMetre <= NEAR_PIXELS_PER_METRE : pixelsPerMetre < FAR_PIXELS_PER_METRE;
}
