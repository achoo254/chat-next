// A softer sleeping pose, done in code after the clip poses the bones. The side-sleeping clip turns the head, the neck and
// the upper arms far from the body, and the chibi's skin (head, shoulders and arms are one surface) tears there. Turning
// those bones part of the way back towards their rest rotation keeps the curled look and tears less: over the 15 models
// the share of skin edges stretched more than 2.5 times fell from about 6.2% to 4.3% (a model at rest measures 2.8%),
// measured on the clip's middle frame with the head, neck and upper arms kept at half their turn.
import { Quaternion } from "@babylonjs/core/Maths/math.vector";

/** The bones softened while a person sleeps (the node names of the rig). */
export const SLEEP_SOFTENED_BONES: readonly string[] = ["head", "neck_01", "upperarm_l", "upperarm_r"];

/** How much of the clip's turn each softened bone keeps: 1 is the clip as made, 0 the rest pose. */
export const SLEEP_KEEP = 0.5;

/** `out` = the rotation `keep` of the way from `rest` (0) to `posed` (1). Returns `out`; `out` must not be `posed` or `rest`. */
export function softenTowardRest(rest: Quaternion, posed: Quaternion, keep: number, out: Quaternion): Quaternion {
	return Quaternion.SlerpToRef(rest, posed, Math.min(1, Math.max(0, keep)), out);
}
