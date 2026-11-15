// The 3D part of public/office/office-assets.json (written by the asset
// pipeline next to the 2D pictures):
//   floors[].scene  the floor's baked shell GLB, its day and night lightmaps
//                   at 1024 and 2048, one props GLB holding every model first
//                   used on that floor (one named node per model) and the
//                   list of those model names; where each prop stands is in
//                   the shell GLB's asset.extras (shell-extras.ts);
//   character       the rigged model, its clip names and one skin atlas
//                   (columns × rows cells, `count` of them used, named);
//   accessories     one GLB with a named node per accessory and, per name,
//                   the bone it hangs from and a scale;
//   sfx.sounds      sound files by name, with loop flag and length.
// Everything is optional and checked piece by piece: whatever is missing or
// odd stays a placeholder (or a WebAudio tone); the whole file is ignored when
// it was made for another layout (layoutSha256) or another format version.
// office-assets.ts (shared with the 2D view) checks the 2D pictures.
import { ASSETS_BASE, layoutHash } from "../../machines/office/office-assets.ts";
import { arrayOf, isRecord, numberOf, stringOf } from "../../machines/office/office-json.ts";
import type { FloorLevel } from "../../machines/office/office-rooms.ts";

export const SCENE_ASSETS_FORMAT_VERSION = 1;

export type LightmapSize = 1024 | 2048;

export interface FloorAssets {
	readonly shell: string | null;
	/** Lightmap file by time of day and edge size. */
	readonly lightmaps: { readonly day: Partial<Record<LightmapSize, string>>; readonly night: Partial<Record<LightmapSize, string>> };
	/** The GLB with the models first used on this floor (one node per model), or null. */
	readonly props: string | null;
	/** The model names that GLB holds. */
	readonly models: readonly string[];
}

export interface SkinAtlas {
	readonly file: string;
	readonly columns: number;
	readonly rows: number;
	/** Cells in use, left to right then top to bottom; never more than columns × rows. */
	readonly count: number;
	readonly names: readonly string[];
}

export interface CharacterAssets {
	readonly file: string;
	readonly clips: readonly string[];
	readonly skins: SkinAtlas | null;
}

export interface AccessoryItem {
	readonly bone: string;
	readonly scale: number;
}

export interface AccessoryAssets {
	readonly file: string;
	readonly items: ReadonlyMap<string, AccessoryItem>;
}

export interface SoundFile {
	readonly file: string;
	readonly loop: boolean;
	readonly seconds: number;
}

export interface SceneAssets {
	readonly floors: ReadonlyMap<FloorLevel, FloorAssets>;
	readonly character: CharacterAssets | null;
	readonly accessories: AccessoryAssets | null;
	/** Sound files by the asset file's names (office-sfx.ts maps them to scene events). */
	readonly sounds: ReadonlyMap<string, SoundFile>;
}

export const NO_SCENE_ASSETS: SceneAssets = { floors: new Map(), character: null, accessories: null, sounds: new Map() };

/** A file under ASSETS_BASE: a name, or one folder and a name; nothing that climbs out. */
const SAFE_PATH = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)?$/;
/** Model, accessory, sound and bone names: plain identifiers. */
const SAFE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** Atlas grids beyond this are not a skin atlas. */
const MAX_ATLAS_SIDE = 16;

function file(value: unknown): string | null {
	const s = stringOf(value);
	return SAFE_PATH.test(s) ? s : null;
}

function safeName(value: unknown): string | null {
	const s = stringOf(value);
	return SAFE_NAME.test(s) ? s : null;
}

function names(value: unknown): string[] {
	return [...new Set(arrayOf(value).flatMap((v) => safeName(v) ?? []))];
}

function sizes(value: unknown): Partial<Record<LightmapSize, string>> {
	const r = isRecord(value) ? value : {};
	const out: Partial<Record<LightmapSize, string>> = {};
	const small = file(r["1024"]);
	const large = file(r["2048"]);
	if (small !== null) out[1024] = small;
	if (large !== null) out[2048] = large;
	return out;
}

function floorScene(value: unknown): FloorAssets {
	const scene = isRecord(value) ? value : {};
	const lightmaps = isRecord(scene.lightmaps) ? scene.lightmaps : {};
	const props = file(scene.props);
	return {
		shell: file(scene.shell),
		lightmaps: { day: sizes(lightmaps.day), night: sizes(lightmaps.night) },
		props,
		// Names without their GLB are of no use.
		models: props === null ? [] : names(scene.models),
	};
}

function gridSide(value: unknown): number | null {
	const n = numberOf(value);
	return n !== null && Number.isInteger(n) && n >= 1 && n <= MAX_ATLAS_SIDE ? n : null;
}

function skinAtlas(value: unknown): SkinAtlas | null {
	if (!isRecord(value)) return null;
	const atlas = file(value.file);
	const columns = gridSide(value.columns);
	const rows = gridSide(value.rows);
	const count = numberOf(value.count);
	if (atlas === null || columns === null || rows === null || count === null || !Number.isInteger(count) || count < 1) return null;
	return { file: atlas, columns, rows, count: Math.min(count, columns * rows), names: arrayOf(value.names).map(stringOf) };
}

function characterOf(value: unknown): CharacterAssets | null {
	if (!isRecord(value)) return null;
	const model = file(value.file);
	if (model === null) return null;
	return { file: model, clips: names(value.clips), skins: skinAtlas(value.skins) };
}

function accessoriesOf(value: unknown): AccessoryAssets | null {
	if (!isRecord(value)) return null;
	const glb = file(value.file);
	if (glb === null || !isRecord(value.items)) return null;
	const items = new Map<string, AccessoryItem>();
	for (const [name, item] of Object.entries(value.items)) {
		if (!SAFE_NAME.test(name) || !isRecord(item)) continue;
		const bone = safeName(item.bone);
		const scale = numberOf(item.scale) ?? 1;
		if (bone !== null && scale > 0 && scale <= 10) items.set(name, { bone, scale });
	}
	return items.size === 0 ? null : { file: glb, items };
}

function soundsOf(value: unknown): Map<string, SoundFile> {
	const out = new Map<string, SoundFile>();
	const sounds = isRecord(value) && isRecord(value.sounds) ? value.sounds : {};
	for (const [name, entry] of Object.entries(sounds)) {
		if (!SAFE_NAME.test(name) || !isRecord(entry)) continue;
		const f = file(entry.file);
		if (f === null) continue;
		const seconds = numberOf(entry.seconds);
		out.set(name, { file: f, loop: entry.loop === true, seconds: seconds !== null && seconds > 0 ? seconds : 0 });
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
		if (isRecord(entry.scene)) floors.set(level, floorScene(entry.scene));
	}
	return { floors, character: characterOf(json.character), accessories: accessoriesOf(json.accessories), sounds: soundsOf(json.sfx) };
}

/** The lightmap pair for a floor at a size (falling back to the other size), or null without both. */
export function lightmapPair(floor: FloorAssets, size: LightmapSize): { readonly day: string; readonly night: string } | null {
	const other = size === 1024 ? 2048 : 1024;
	const day = floor.lightmaps.day[size] ?? floor.lightmaps.day[other];
	const night = floor.lightmaps.night[size] ?? floor.lightmaps.night[other];
	return day === undefined || night === undefined ? null : { day, night };
}

/** Model name → the props GLB holding it, over every floor (the first floor listing a name wins). */
export function propSources(assets: SceneAssets): ReadonlyMap<string, string> {
	const out = new Map<string, string>();
	const levels = [...assets.floors.keys()].sort((a, b) => a - b);
	for (const level of levels) {
		const floor = assets.floors.get(level);
		if (floor?.props == null) continue;
		for (const name of floor.models) if (!out.has(name)) out.set(name, floor.props);
	}
	return out;
}

/** The atlas cell of skin `index` as a texture transform (v runs down the picture, like glTF UVs). */
export function skinCell(atlas: SkinAtlas, index: number): { readonly uScale: number; readonly vScale: number; readonly uOffset: number; readonly vOffset: number } {
	const cell = ((Math.trunc(index) % atlas.count) + atlas.count) % atlas.count;
	const column = cell % atlas.columns;
	const row = Math.floor(cell / atlas.columns);
	return { uScale: 1 / atlas.columns, vScale: 1 / atlas.rows, uOffset: column / atlas.columns, vOffset: row / atlas.rows };
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
