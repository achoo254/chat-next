// The render quality ladder of the office, cheapest first (shape from Chùa
// Nhỏ's quality-levels.ts, rungs from the character and room spike): phones
// start on medium (bloom, no shadow light, no depth of field, no SSAO),
// computers on high; SSAO only on ultra, the tilt-shift depth of field from
// high up. The automatic scaler moves between rungs by measured frame time.

export type QualityId = "low" | "medium" | "high" | "ultra";

export interface QualityLevel {
	readonly id: QualityId;
	/** Device pixels per CSS pixel the canvas may use (capped by the screen's own ratio). */
	readonly maxPixelRatio: number;
	/** Shadow map edge in texels for the one character shadow light; 0 = blob shadows only. */
	readonly shadowMapSize: number;
	readonly bloom: boolean;
	/** Tilt-shift blur (depth of field). */
	readonly depthOfField: boolean;
	/** Screen-space ambient occlusion: desktop only. */
	readonly ssao: boolean;
	readonly fxaa: boolean;
	/** Characters animated every frame; the next ones at half rate, the rest at a quarter. */
	readonly fullRateCharacters: number;
	/** Edge of the lightmaps loaded on this rung (the bake ships 1024 and 2048). */
	readonly lightmapSize: 1024 | 2048;
}

export const QUALITY_LEVELS: readonly QualityLevel[] = [
	{ id: "low", maxPixelRatio: 1, shadowMapSize: 0, bloom: false, depthOfField: false, ssao: false, fxaa: true, fullRateCharacters: 2, lightmapSize: 1024 },
	{ id: "medium", maxPixelRatio: 1.5, shadowMapSize: 0, bloom: true, depthOfField: false, ssao: false, fxaa: true, fullRateCharacters: 4, lightmapSize: 1024 },
	{ id: "high", maxPixelRatio: 1.75, shadowMapSize: 1024, bloom: true, depthOfField: true, ssao: false, fxaa: true, fullRateCharacters: 6, lightmapSize: 2048 },
	{ id: "ultra", maxPixelRatio: 2, shadowMapSize: 2048, bloom: true, depthOfField: true, ssao: true, fxaa: true, fullRateCharacters: 8, lightmapSize: 2048 },
];

export const TOP_QUALITY_LEVEL = QUALITY_LEVELS.length - 1;

/** The rung a device starts on: phones (coarse pointer) on medium, computers on high. */
export function startingQualityLevel(coarsePointer: boolean): number {
	return coarsePointer ? 1 : 2;
}

export function qualityIndexOf(id: string | null): number | null {
	const index = QUALITY_LEVELS.findIndex((level) => level.id === id);
	return index >= 0 ? index : null;
}

export function qualityLevelAt(index: number): QualityLevel {
	const clamped = Math.max(0, Math.min(TOP_QUALITY_LEVEL, Math.round(Number.isFinite(index) ? index : 0)));
	const level = QUALITY_LEVELS[clamped];
	if (level === undefined) throw new Error(`no quality level at ${index}`);
	return level;
}
