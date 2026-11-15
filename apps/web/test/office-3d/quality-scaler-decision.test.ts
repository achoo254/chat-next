// Copied with the scaler from Chùa Nhỏ (engine/quality-scaler-decision.test.ts), plus the office's quality rungs.
import { describe, expect, it } from "vitest";
import { QUALITY_LEVELS, qualityIndexOf, qualityLevelAt, startingQualityLevel, TOP_QUALITY_LEVEL } from "../../src/office-3d/engine/quality-levels.ts";
import { DEFAULT_SCALER_CONFIG, initialScalerState, stepQualityScaler, type ScalerState } from "../../src/office-3d/engine/quality-scaler-decision.ts";

/** Runs `frames` frames of `frameMs` each and returns the final state and every change made on the way. */
function run(state: ScalerState, frameMs: number, frames: number): { state: ScalerState; changes: number[] } {
	const changes: number[] = [];
	let current = state;
	for (let i = 0; i < frames; i += 1) {
		const step = stepQualityScaler(current, frameMs);
		if (step.change !== 0) changes.push(step.change);
		current = step.state;
	}
	return { state: current, changes };
}

describe("stepQualityScaler", () => {
	it("stays put while frames keep up but there is no higher rung", () => {
		const { state, changes } = run(initialScalerState(3, 3), 16.7, 2000);
		expect(changes).toEqual([]);
		expect(state.level).toBe(3);
	});

	it("steps down after slow frames last a little over a second", () => {
		const start = initialScalerState(2, 3);
		expect(run(start, 33, 20).changes).toEqual([]);
		const longer = run(start, 33, 60);
		expect(longer.changes).toEqual([-1]);
		expect(longer.state.level).toBe(1);
	});

	it("keeps stepping down, one rung per cooldown, and never below the lowest rung", () => {
		const { state, changes } = run(initialScalerState(3, 3), 50, 600);
		expect(changes).toEqual([-1, -1, -1]);
		expect(state.level).toBe(0);
	});

	it("climbs back slowly after keeping up for several seconds", () => {
		const start = initialScalerState(1, 3);
		expect(run(start, 16.7, 300).changes).toEqual([]);
		const { state, changes } = run(start, 16.7, 600);
		expect(changes).toEqual([1]);
		expect(state.level).toBe(2);
	});

	it("lowers the ceiling when a climb fails soon after, so it does not see-saw", () => {
		let state = initialScalerState(1, 3);
		state = run(state, 16.7, 600).state;
		expect(state.level).toBe(2);
		state = run(state, 40, 100).state;
		expect(state.level).toBe(1);
		expect(state.ceiling).toBe(1);
		const later = run(state, 16.7, 3000);
		expect(later.changes).toEqual([]);
		expect(later.state.level).toBe(1);
	});

	it("ignores huge frames from a hidden tab or a pause instead of averaging them", () => {
		const start = initialScalerState(2, 3);
		const step = stepQualityScaler(start, 5000);
		expect(step.change).toBe(0);
		expect(step.state).toBe(start);
		expect(stepQualityScaler(start, Number.NaN).state).toBe(start);
		expect(stepQualityScaler(start, -3).state).toBe(start);
	});

	it("waits out the cooldown after a change before deciding again", () => {
		const afterDrop = run(initialScalerState(3, 3), 40, 40).state;
		expect(afterDrop.level).toBe(2);
		expect(afterDrop.cooldownMs).toBeGreaterThan(0);
		const during = run(afterDrop, 40, Math.floor(DEFAULT_SCALER_CONFIG.cooldownMs / 40) - 1);
		expect(during.changes).toEqual([]);
	});
});

describe("office quality levels", () => {
	it("grow more expensive rung by rung", () => {
		for (let i = 1; i < QUALITY_LEVELS.length; i += 1) {
			const lower = qualityLevelAt(i - 1);
			const higher = qualityLevelAt(i);
			expect(higher.maxPixelRatio).toBeGreaterThanOrEqual(lower.maxPixelRatio);
			expect(higher.shadowMapSize).toBeGreaterThanOrEqual(lower.shadowMapSize);
			expect(higher.fullRateCharacters).toBeGreaterThanOrEqual(lower.fullRateCharacters);
			expect(higher.lightmapSize).toBeGreaterThanOrEqual(lower.lightmapSize);
		}
	});

	it("keeps SSAO to the top rung, depth of field from high, and phones on medium without either", () => {
		expect(QUALITY_LEVELS.filter((l) => l.ssao).map((l) => l.id)).toEqual(["ultra"]);
		expect(QUALITY_LEVELS.filter((l) => l.depthOfField).map((l) => l.id)).toEqual(["high", "ultra"]);
		const phone = qualityLevelAt(startingQualityLevel(true));
		expect(phone).toMatchObject({ id: "medium", ssao: false, depthOfField: false, shadowMapSize: 0, maxPixelRatio: 1.5, lightmapSize: 1024 });
		expect(startingQualityLevel(false)).toBeGreaterThan(startingQualityLevel(true));
	});

	it("clamps out-of-range rungs and reads rung names", () => {
		expect(qualityLevelAt(-4).id).toBe("low");
		expect(qualityLevelAt(99)).toBe(qualityLevelAt(TOP_QUALITY_LEVEL));
		expect(qualityLevelAt(Number.NaN).id).toBe("low");
		expect(qualityIndexOf("high")).toBe(2);
		expect(qualityIndexOf("max")).toBeNull();
		expect(qualityIndexOf(null)).toBeNull();
	});
});
