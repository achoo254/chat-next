// Typing as a motion added on top of the seated writing clip (no CC0 typing
// clip exists; the character and room spike measured it stays under 90° at
// the wrist). Pure maths: the offsets for one moment, which the character
// adds to the forearms and hands after the clip has posed them. Each hand has
// its own phase so the two do not tap in step.
export interface TypingOffsets {
	/** Extra pitch (radians) of each forearm and hand, around the bone's own sideways axis. */
	readonly lowerarmL: number;
	readonly lowerarmR: number;
	readonly handL: number;
	readonly handR: number;
}

export interface TypingStyle {
	/** Peak forearm swing, degrees (the spike target is 5 to 8). */
	readonly forearmDegrees: number;
	/** Peak extra hand swing, degrees. */
	readonly handDegrees: number;
	/** Taps per second (the spike target is 6 to 8). */
	readonly hertz: number;
}

export const DEFAULT_TYPING: TypingStyle = { forearmDegrees: 6, handDegrees: 8, hertz: 7 };

const DEG = Math.PI / 180;

/**
 * Offsets at `seconds`. `seed` (any number, e.g. the character index) shifts the phases so six typists differ.
 * The swing is a rectified sine (fingers tap down, never lift above the rest pose) mixed with a slower wander.
 */
export function typingOffsets(seconds: number, seed: number, style: TypingStyle = DEFAULT_TYPING): TypingOffsets {
	if (!Number.isFinite(seconds)) return { lowerarmL: 0, lowerarmR: 0, handL: 0, handR: 0 };
	const w = 2 * Math.PI * style.hertz;
	const phaseL = seed * 1.7;
	const phaseR = seed * 1.7 + 2.1;
	// Two taps a beat never line up exactly: a slow wander changes each hand's rhythm a little.
	const tap = (phase: number): number => Math.abs(Math.sin(w * seconds * (1 + 0.07 * Math.sin(seconds * 0.9 + phase)) + phase));
	const left = tap(phaseL);
	const right = tap(phaseR);
	return {
		lowerarmL: -left * style.forearmDegrees * DEG,
		lowerarmR: -right * style.forearmDegrees * DEG,
		handL: -left * style.handDegrees * DEG,
		handR: -right * style.handDegrees * DEG,
	};
}
