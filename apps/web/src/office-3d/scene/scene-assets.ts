// The 3D part of public/office/office-assets.json (made with the bake): per
// floor its shell model and day and night lightmaps at 1024 and 2048, the
// furniture and small-prop models by layout name (one model each, drawn as
// instances on every floor), the character model with its skins, and sound
// files. Everything is optional: whatever is missing, or the whole file when
// it was baked from another layout (layoutSha256), stays a placeholder
// block. office-assets.ts (shared with the 2D view) checks the 2D pictures.
import { ASSETS_BASE, layoutHash } from "../../machines/office/office-assets.ts";
import { arrayOf, isRecord, stringOf } from "../../machines/office/office-json.ts";
import type { FloorLevel } from "../../machines/office/office-rooms.ts";

export const SCENE_ASSETS_FORMAT_VERSION = 1;

export interface FloorAssets {
	readonly shell: string | null;
	/** Lightmap file by time of day and edge size. */
	readonly lightmaps: { readonly day: Partial<Record<1024 | 2048, string>>; readonly night: Partial<Record<1024 | 2048, string>> };
}

export interface SceneAssets {
	readonly floors: ReadonlyMap<FloorLevel, FloorAssets>;
	/** Layout prop name → model file. */
	readonly props: ReadonlyMap<string, string>;
	readonly character: { readonly model: string; readonly skins: readonly string[] } | null;
	readonly sounds: ReadonlyMap<string, string>;
}

export const NO_SCENE_ASSETS: SceneAssets = { floors: new Map(), props: new Map(), character: null, sounds: new Map() };

/** A file under ASSETS_BASE: a name, or one folder and a name; nothing that climbs out. */
const SAFE_PATH = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)?$/;

function file(value: unknown): string | null {
	const s = stringOf(value);
	return SAFE_PATH.test(s) ? s : null;
}

function sizes(value: unknown): Partial<Record<1024 | 2048, string>> {
	const r = isRecord(value) ? value : {};
	const out: Partial<Record<1024 | 2048, string>> = {};
	const small = file(r["1024"]);
	const large = file(r["2048"]);
	if (small !== null) out[1024] = small;
	if (large !== null) out[2048] = large;
	return out;
}

function names(value: unknown): Map<string, string> {
	const out = new Map<string, string>();
	if (!isRecord(value)) return out;
	for (const [name, v] of Object.entries(value)) {
		const f = file(v);
		if (f !== null && /^[a-z0-9-]+$/.test(name)) out.set(name, f);
	}
	return out;
}

/** The 3D assets of a parsed asset file, or none when it is not for `hash` (the current layout's). */
export function parseSceneAssets(json: unknown, hash: string): SceneAssets {
	if (!isRecord(json) || json.formatVersion !== SCENE_ASSETS_FORMAT_VERSION || json.layoutSha256 !== hash) return NO_SCENE_ASSETS;
	const floors = new Map<FloorLevel, FloorAssets>();
	for (const entry of arrayOf(json.floors)) {
		if (!isRecord(entry)) continue;
		const level = entry.level;
		if (level !== 1 && level !== 2 && level !== 3) continue;
		const lightmaps = isRecord(entry.lightmaps) ? entry.lightmaps : {};
		floors.set(level, { shell: file(entry.shell), lightmaps: { day: sizes(lightmaps.day), night: sizes(lightmaps.night) } });
	}
	const c = isRecord(json.character) ? json.character : null;
	const model = c === null ? null : file(c.model);
	return {
		floors,
		props: names(json.props),
		character: model === null ? null : { model, skins: arrayOf(c?.skins).flatMap((s) => file(s) ?? []) },
		sounds: names(json.sounds),
	};
}

/** The lightmap pair for a floor at a size (falling back to the other size), or null without both. */
export function lightmapPair(floor: FloorAssets, size: 1024 | 2048): { readonly day: string; readonly night: string } | null {
	const other = size === 1024 ? 2048 : 1024;
	const day = floor.lightmaps.day[size] ?? floor.lightmaps.day[other];
	const night = floor.lightmaps.night[size] ?? floor.lightmaps.night[other];
	return day === undefined || night === undefined ? null : { day, night };
}

export function assetUrl(name: string): string {
	return `${ASSETS_BASE}${name}`;
}

/** Fetches the asset file; any failure means placeholders (logged once). */
export async function loadSceneAssets(signal: AbortSignal): Promise<SceneAssets> {
	try {
		const response = await fetch(`${ASSETS_BASE}office-assets.json`, { cache: "no-cache", signal });
		if (!response.ok) return NO_SCENE_ASSETS;
		const json: unknown = await response.json();
		return parseSceneAssets(json, await layoutHash());
	} catch (error) {
		if (!signal.aborted) console.info("office: no 3D assets, drawing placeholders", error);
		return NO_SCENE_ASSETS;
	}
}
