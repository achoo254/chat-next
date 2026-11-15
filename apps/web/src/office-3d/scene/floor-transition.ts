// The elevator effect between floors: the view glides up (or down) and fades
// for about 0.6 s; the floor swaps at the darkest moment. With reduced motion
// the floor cuts at once. Pure: the world asks it each frame for the glide
// offset, the fade and whether to swap now.
import type { FloorLevel } from "../../machines/office/office-rooms.ts";

export const TRANSITION_MS = 600;
/** Metres the view travels during the glide, per floor of difference. */
const GLIDE_METRES = 2.2;

export interface TransitionFrame {
	/** The floor to draw now. */
	readonly floor: FloorLevel;
	/** Offset of the camera target (metres up). */
	readonly lift: number;
	/** 0 clear, 1 fully faded. */
	readonly fade: number;
}

export interface FloorTransition {
	/** The floor wanted (from the floor tabs or following). */
	request(level: FloorLevel, nowMs: number): void;
	frame(nowMs: number): TransitionFrame;
}

export function createFloorTransition(initial: FloorLevel, reducedMotion: boolean): FloorTransition {
	let shown: FloorLevel = initial;
	let move: { from: FloorLevel; to: FloorLevel; start: number } | null = null;
	return {
		request(level, nowMs) {
			const current = move?.to ?? shown;
			if (level === current) return;
			if (reducedMotion) {
				shown = level;
				move = null;
				return;
			}
			move = { from: move === null ? shown : move.from, to: level, start: nowMs };
		},
		frame(nowMs) {
			if (move === null) return { floor: shown, lift: 0, fade: 0 };
			const t = Math.max(0, (nowMs - move.start) / TRANSITION_MS);
			if (t >= 1) {
				shown = move.to;
				move = null;
				return { floor: shown, lift: 0, fade: 0 };
			}
			const direction = Math.sign(move.to - move.from) * Math.max(1, Math.abs(move.to - move.from));
			// First half: glide away from the old floor and fade out; second half: arrive at the new one and fade in.
			if (t < 0.5) return { floor: move.from, lift: direction * GLIDE_METRES * (t / 0.5), fade: t / 0.5 };
			shown = move.to;
			return { floor: move.to, lift: -direction * GLIDE_METRES * ((1 - t) / 0.5), fade: (1 - t) / 0.5 };
		},
	};
}
