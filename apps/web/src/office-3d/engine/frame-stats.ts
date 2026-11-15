// Frame timing for window.__office (tests and on-device measurement): a ring
// of recent frame durations, from which the mean frame rate and the "p95"
// frame rate (the rate the slowest 5 % of frames still reach) are read. Pure,
// no engine (from the character and room spike).

export interface FrameSummary {
	readonly frames: number;
	readonly meanFps: number;
	/** 1000 / (95th percentile frame duration): 30 means 95 % of frames took at most 33.3 ms. */
	readonly p95Fps: number;
	readonly worstMs: number;
}

export class FrameStats {
	private readonly durations: Float64Array;
	private count = 0;
	private next = 0;

	constructor(capacity = 3600) {
		if (!Number.isInteger(capacity) || capacity < 1) throw new Error("capacity must be a positive integer");
		this.durations = new Float64Array(capacity);
	}

	/** Adds one frame's duration in milliseconds; non-finite or negative values are ignored. */
	push(ms: number): void {
		if (!Number.isFinite(ms) || ms < 0) return;
		this.durations[this.next] = ms;
		this.next = (this.next + 1) % this.durations.length;
		this.count = Math.min(this.count + 1, this.durations.length);
	}

	reset(): void {
		this.count = 0;
		this.next = 0;
	}

	summary(): FrameSummary {
		if (this.count === 0) return { frames: 0, meanFps: 0, p95Fps: 0, worstMs: 0 };
		const sorted = Array.from(this.durations.subarray(0, this.count)).sort((a, b) => a - b);
		const total = sorted.reduce((sum, ms) => sum + ms, 0);
		const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
		const worst = sorted[sorted.length - 1] ?? 0;
		return { frames: this.count, meanFps: total > 0 ? (1000 * this.count) / total : 0, p95Fps: p95 > 0 ? 1000 / p95 : 0, worstMs: worst };
	}
}
