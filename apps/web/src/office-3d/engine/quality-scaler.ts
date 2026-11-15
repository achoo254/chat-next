// The automatic quality scaler at run time (from Chùa Nhỏ): feeds every
// frame's duration to the pure decision and, on a change, applies the new
// rung (canvas resolution, shadows, post-processing, animation rate) through
// `apply`. A rung pinned from the address stays for the whole visit.
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { qualityLevelAt, TOP_QUALITY_LEVEL, type QualityLevel } from "./quality-levels.ts";
import { initialScalerState, stepQualityScaler, type ScalerState } from "./quality-scaler-decision.ts";

export interface QualityScaler {
	readonly level: QualityLevel;
	onFrame(frameMs: number): void;
	/** Applies the starting rung (after the warm-up frames). */
	start(): void;
	/** Re-applies the canvas resolution (the window moved to a screen with another pixel ratio). */
	refreshPixelRatio(): void;
}

/** Canvas pixels per CSS pixel for a rung, never above what the screen has. */
export function pixelRatioFor(level: QualityLevel): number {
	return Math.min(window.devicePixelRatio || 1, level.maxPixelRatio);
}

export function createQualityScaler(engine: AbstractEngine, startLevel: number, pinned: boolean, apply: (level: QualityLevel) => void): QualityScaler {
	let state: ScalerState = initialScalerState(startLevel, TOP_QUALITY_LEVEL);
	let level = qualityLevelAt(state.level);
	let started = false;
	const applyLevel = (): void => {
		engine.setHardwareScalingLevel(1 / pixelRatioFor(level));
		apply(level);
	};
	return {
		get level() {
			return level;
		},
		start() {
			started = true;
			applyLevel();
		},
		onFrame(frameMs) {
			if (pinned || !started) return;
			const step = stepQualityScaler(state, frameMs);
			state = step.state;
			if (step.change === 0) return;
			level = qualityLevelAt(state.level);
			applyLevel();
		},
		refreshPixelRatio() {
			engine.setHardwareScalingLevel(1 / pixelRatioFor(level));
		},
	};
}
