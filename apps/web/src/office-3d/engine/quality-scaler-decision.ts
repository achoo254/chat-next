/**
 * The automatic quality scaler's brain, kept pure so it can be tested frame by frame: feed it each frame's duration
 * and it says when to step the quality ladder down (frames too slow for a while) or back up (fast for much longer).
 *
 * Browsers cap frames at the display's refresh (60 Hz is about 16.7 ms), so "fast" means "keeping up with 60 fps",
 * not "spare time measured". To stop see-sawing, stepping down soon after stepping up lowers the ceiling: the rung
 * that just failed is not tried again in this visit.
 */

export interface ScalerConfig {
	/** Smoothed frame time above this counts as slow (about 45 fps). */
	readonly slowFrameMs: number;
	/** Smoothed frame time at or below this counts as keeping up (about 55 fps). */
	readonly fastFrameMs: number;
	/** Slow for this long steps one rung down. */
	readonly downAfterMs: number;
	/** Keeping up for this long steps one rung up. */
	readonly upAfterMs: number;
	/** No decision for this long after any change, while the new settings warm up. */
	readonly cooldownMs: number;
	/** Stepping down within this long of stepping up caps the ladder below the rung that failed. */
	readonly unstableWindowMs: number;
	/** Frames longer than this (a hidden tab, a GC pause, a shader compile) are ignored, not averaged. */
	readonly ignoreFrameMs: number;
	/** Weight of the newest frame in the moving average. */
	readonly smoothing: number;
}

export const DEFAULT_SCALER_CONFIG: ScalerConfig = {
	slowFrameMs: 22,
	fastFrameMs: 18,
	downAfterMs: 1200,
	upAfterMs: 8000,
	cooldownMs: 2000,
	unstableWindowMs: 12000,
	ignoreFrameMs: 250,
	smoothing: 0.1,
};

export interface ScalerState {
	readonly level: number;
	/** The highest rung the scaler may still climb to. */
	readonly ceiling: number;
	readonly averageMs: number | null;
	readonly slowForMs: number;
	readonly fastForMs: number;
	readonly cooldownMs: number;
	/** Time since the last step up, or null when the last change was not a step up. */
	readonly sinceStepUpMs: number | null;
}

export interface ScalerStep {
	readonly state: ScalerState;
	/** -1 step down, 1 step up, 0 stay. */
	readonly change: -1 | 0 | 1;
}

export function initialScalerState(level: number, ceiling: number): ScalerState {
	const top = Math.max(0, ceiling);
	return {
		level: Math.max(0, Math.min(level, top)),
		ceiling: top,
		averageMs: null,
		slowForMs: 0,
		fastForMs: 0,
		cooldownMs: 0,
		sinceStepUpMs: null,
	};
}

/** Folds one frame's duration into the state and decides whether to change rung. */
export function stepQualityScaler(state: ScalerState, frameMs: number, config: ScalerConfig = DEFAULT_SCALER_CONFIG): ScalerStep {
	if (!Number.isFinite(frameMs) || frameMs <= 0 || frameMs > config.ignoreFrameMs) return { state, change: 0 };

	const averageMs = state.averageMs === null ? frameMs : state.averageMs + (frameMs - state.averageMs) * config.smoothing;
	const sinceStepUpMs = state.sinceStepUpMs === null ? null : state.sinceStepUpMs + frameMs;
	const slow = averageMs > config.slowFrameMs;
	const fast = averageMs <= config.fastFrameMs;
	const next: ScalerState = {
		...state,
		averageMs,
		sinceStepUpMs,
		slowForMs: slow ? state.slowForMs + frameMs : 0,
		fastForMs: fast ? state.fastForMs + frameMs : 0,
		cooldownMs: Math.max(0, state.cooldownMs - frameMs),
	};
	// While new settings warm up (shaders compiling, targets resizing) frames are averaged but not held against them.
	if (next.cooldownMs > 0) return { state: { ...next, slowForMs: 0, fastForMs: 0 }, change: 0 };

	if (next.slowForMs >= config.downAfterMs && next.level > 0) {
		const failedRecentClimb = sinceStepUpMs !== null && sinceStepUpMs <= config.unstableWindowMs;
		const level = next.level - 1;
		return {
			state: {
				...next,
				level,
				ceiling: failedRecentClimb ? level : next.ceiling,
				averageMs: null,
				slowForMs: 0,
				fastForMs: 0,
				cooldownMs: config.cooldownMs,
				sinceStepUpMs: null,
			},
			change: -1,
		};
	}

	if (next.fastForMs >= config.upAfterMs && next.level < next.ceiling) {
		return {
			state: {
				...next,
				level: next.level + 1,
				averageMs: null,
				slowForMs: 0,
				fastForMs: 0,
				cooldownMs: config.cooldownMs,
				sinceStepUpMs: 0,
			},
			change: 1,
		};
	}

	return { state: next, change: 0 };
}
