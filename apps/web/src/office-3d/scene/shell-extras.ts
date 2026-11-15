// What the asset pipeline writes into a floor shell GLB's asset.extras:
// where every prop of the floor stands (instances: model name → list of
// [x, y, z, rotY] in layout coordinates, the same places the bake cast their
// shadows from), how the lightmap is stored (intensityScale: the bake wrote
// light at 1 / scale) and the window panes' day and night colours. Read from
// the parsed glTF JSON; anything missing or odd reads as "not given", so the
// scene keeps its own defaults (layout places, half-intensity bake). Pure, no
// engine.
import { arrayOf, isRecord, numberOf } from "../../machines/office/office-json.ts";
import type { Place } from "./scene-layout.ts";

export type Rgb = readonly [number, number, number];

export interface ShellExtras {
	/** Every placed prop of the floor, or null when the shell lists none. */
	readonly places: readonly Place[] | null;
	/** Linear-light factor the lightmap was divided by, or null. */
	readonly intensityScale: number | null;
	readonly windowColours: { readonly day: Rgb; readonly night: Rgb } | null;
}

export const NO_SHELL_EXTRAS: ShellExtras = { places: null, intensityScale: null, windowColours: null };

const MODEL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** Props further than this from the floor's centre are a broken entry, not furniture. */
const MAX_COORD = 200;

function rgb(value: unknown): Rgb | null {
	const n = arrayOf(value).map(numberOf);
	const [r, g, b] = n;
	if (n.length !== 3 || r == null || g == null || b == null) return null;
	const clamp = (c: number): number => Math.max(0, Math.min(4, c));
	return [clamp(r), clamp(g), clamp(b)];
}

function placesOf(value: unknown): Place[] | null {
	if (!isRecord(value)) return null;
	const places: Place[] = [];
	for (const [name, list] of Object.entries(value)) {
		if (!MODEL_NAME.test(name)) continue;
		for (const entry of arrayOf(list)) {
			const [x, y, z, rotY] = arrayOf(entry).map(numberOf);
			if (x == null || y == null || z == null || Math.abs(x) > MAX_COORD || Math.abs(y) > MAX_COORD || Math.abs(z) > MAX_COORD) continue;
			places.push({ name, x, y, z, rotY: rotY ?? 0, anchor: "" });
		}
	}
	return places.length === 0 ? null : places;
}

/** The extras of a shell GLB from its parsed glTF JSON. */
export function parseShellExtras(gltf: unknown): ShellExtras {
	const asset = isRecord(gltf) && isRecord(gltf.asset) ? gltf.asset : null;
	const extras = asset !== null && isRecord(asset.extras) ? asset.extras : null;
	if (extras === null) return NO_SHELL_EXTRAS;
	const lightmap = isRecord(extras.lightmap) ? extras.lightmap : {};
	const scale = numberOf(lightmap.intensityScale);
	const windows = isRecord(extras.windowViewColours) ? extras.windowViewColours : {};
	const day = rgb(windows.day);
	const night = rgb(windows.night);
	return {
		places: placesOf(extras.instances),
		intensityScale: scale !== null && scale > 0 && scale <= 16 ? scale : null,
		windowColours: day === null || night === null ? null : { day, night },
	};
}

/** Gamma-space multiplier that undoes a bake stored at 1 / `intensityScale` of the light. */
export function gammaScale(intensityScale: number): number {
	return Math.pow(intensityScale, 1 / 2.2);
}
