// Which characters animate how often (plan decision 7): in the camera's
// frame, the busiest and nearest few run every frame, the next ones every
// other frame, the rest every fourth; out of the frame they stop (they still
// move on in logic, actor-motion.ts). Pure, no engine.

export interface LodEntry {
	readonly key: string;
	readonly onScreen: boolean;
	/** Walking or working: motion people notice. */
	readonly active: boolean;
	/** Distance to the camera's target, metres. */
	readonly distance: number;
}

/** 1 = every frame, 2 = every other frame, 4 = every fourth, 0 = stopped. */
export type UpdateEvery = 0 | 1 | 2 | 4;

/** The next tier after the full-rate characters gets this many at half rate. */
const HALF_RATE = 2;

export function animationRates(entries: readonly LodEntry[], fullRate: number): ReadonlyMap<string, UpdateEvery> {
	const rates = new Map<string, UpdateEvery>();
	const shown = entries.filter((e) => e.onScreen);
	for (const e of entries) if (!e.onScreen) rates.set(e.key, 0);
	const ranked = [...shown].sort((a, b) => Number(b.active) - Number(a.active) || a.distance - b.distance || a.key.localeCompare(b.key));
	const full = Math.max(0, Math.round(fullRate));
	ranked.forEach((e, i) => rates.set(e.key, i < full ? 1 : i < full + HALF_RATE ? 2 : 4));
	return rates;
}
