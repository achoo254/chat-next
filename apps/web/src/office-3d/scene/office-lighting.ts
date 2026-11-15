// The light of the office by the viewer's clock (idea from Chùa Nhỏ's
// lighting presets): a table for day, night and "closed" (idle ten minutes,
// lights off), blended by office-daypart.ts's nightMix. It drives what is
// lit live: the sky and key lights of the characters and small props, the
// backdrop, the exposure and bloom, and how bright the screens glow (the
// baked shell takes its light from the day and night lightmaps instead).
// Pure, no engine.

export type Rgb = readonly [number, number, number];

export interface OfficeLight {
	readonly skyIntensity: number;
	readonly skyColor: Rgb;
	readonly groundColor: Rgb;
	readonly keyIntensity: number;
	readonly keyColor: Rgb;
	/** Background around the diorama. */
	readonly backdrop: Rgb;
	readonly exposure: number;
	readonly bloomWeight: number;
	/** Emissive strength of the monitors at desks where someone works. */
	readonly screenGlow: number;
	/** Multiplier on the placeholder floor colours (no lightmap): night is dimmer and warmer. */
	readonly ambient: Rgb;
}

const DAY: OfficeLight = {
	skyIntensity: 0.72,
	skyColor: [1, 0.98, 0.95],
	groundColor: [0.5, 0.44, 0.4],
	keyIntensity: 0.78,
	keyColor: [1, 0.92, 0.8],
	backdrop: [0.84, 0.82, 0.9],
	exposure: 1,
	bloomWeight: 0.3,
	screenGlow: 0.35,
	ambient: [1, 1, 1],
};

const NIGHT: OfficeLight = {
	skyIntensity: 0.34,
	skyColor: [0.6, 0.62, 0.9],
	groundColor: [0.22, 0.2, 0.28],
	keyIntensity: 0.62,
	keyColor: [1, 0.72, 0.48],
	backdrop: [0.3, 0.27, 0.4],
	exposure: 1.1,
	bloomWeight: 0.65,
	screenGlow: 0.9,
	ambient: [0.62, 0.55, 0.62],
};

/** Closed for the day: the lights are out, only a little night sky comes in. */
const CLOSED: OfficeLight = {
	skyIntensity: 0.22,
	skyColor: [0.45, 0.5, 0.85],
	groundColor: [0.12, 0.12, 0.18],
	keyIntensity: 0.15,
	keyColor: [0.6, 0.65, 0.9],
	backdrop: [0.2, 0.19, 0.27],
	exposure: 1,
	bloomWeight: 0.2,
	screenGlow: 0,
	ambient: [0.32, 0.32, 0.42],
};

const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];

/** The light at `nightMix` (0 day, 1 night); `closed` turns the lights out whatever the hour. */
export function officeLighting(nightMix: number, closed: boolean): OfficeLight {
	if (closed) return CLOSED;
	const t = Math.max(0, Math.min(1, Number.isFinite(nightMix) ? nightMix : 0));
	return {
		skyIntensity: mix(DAY.skyIntensity, NIGHT.skyIntensity, t),
		skyColor: mixRgb(DAY.skyColor, NIGHT.skyColor, t),
		groundColor: mixRgb(DAY.groundColor, NIGHT.groundColor, t),
		keyIntensity: mix(DAY.keyIntensity, NIGHT.keyIntensity, t),
		keyColor: mixRgb(DAY.keyColor, NIGHT.keyColor, t),
		backdrop: mixRgb(DAY.backdrop, NIGHT.backdrop, t),
		exposure: mix(DAY.exposure, NIGHT.exposure, t),
		bloomWeight: mix(DAY.bloomWeight, NIGHT.bloomWeight, t),
		screenGlow: mix(DAY.screenGlow, NIGHT.screenGlow, t),
		ambient: mixRgb(DAY.ambient, NIGHT.ambient, t),
	};
}
