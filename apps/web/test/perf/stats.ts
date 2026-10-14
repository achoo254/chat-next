// Pure statistics for the perf gate: percentiles, frame pacing and long-task
// blocking time. Shared by the gate runner and its unit tests.

/** Nearest-rank percentile (p in 0..100) of `values`; NaN when empty. */
export function percentile(values: readonly number[], p: number): number {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.ceil((p / 100) * sorted.length);
	return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? Number.NaN;
}

export interface FrameStats {
	readonly frames: number;
	/** Longest gap between two consecutive frames, ms. */
	readonly maxFrameMs: number;
	/** Frames longer than SLOW_FRAME_MS. */
	readonly slowFrames: number;
	readonly averageFps: number;
}

/**
 * Phase 06: no frame over 32 ms. requestAnimationFrame gaps come in whole
 * vsyncs (16.7 ms at 60 Hz): a 33.3 ms gap is a frame that took at most two
 * vsyncs, the budget; a gap of three vsyncs (50 ms) is a frame over it. The
 * 2 ms margin absorbs vsync jitter.
 */
export const SLOW_FRAME_MS = 34;

/** Frame pacing from requestAnimationFrame timestamps (ms, increasing). */
export function frameStats(timestamps: readonly number[]): FrameStats {
	const gaps: number[] = [];
	for (let index = 1; index < timestamps.length; index++) {
		gaps.push((timestamps[index] ?? 0) - (timestamps[index - 1] ?? 0));
	}
	const first = timestamps[0] ?? 0;
	const last = timestamps[timestamps.length - 1] ?? 0;
	const duration = last - first;
	return {
		frames: gaps.length,
		maxFrameMs: gaps.length === 0 ? 0 : Math.max(...gaps),
		slowFrames: gaps.filter((gap) => gap > SLOW_FRAME_MS).length,
		averageFps: duration > 0 ? (gaps.length * 1000) / duration : 0,
	};
}

export interface LongTaskStats {
	readonly count: number;
	/** Total blocking time: the part of each long task beyond 50 ms, summed. */
	readonly totalBlockingMs: number;
	readonly longestMs: number;
}

/** Long tasks are main-thread tasks over 50 ms (Long Tasks API). */
export function longTaskStats(durations: readonly number[]): LongTaskStats {
	return {
		count: durations.length,
		totalBlockingMs: durations.reduce((sum, duration) => sum + Math.max(0, duration - 50), 0),
		longestMs: durations.length === 0 ? 0 : Math.max(...durations),
	};
}
