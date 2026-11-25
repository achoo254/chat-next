// The Live Map's assets as the art pipeline publishes them
// (hoandat-app/tools/observatory-art/build-observatory-manifest.mjs, copied
// into public/observatory/): the asset table observatory-assets.json (the
// plate in two sizes, the scene table, sprite atlases, all with
// content-hashed names) and the scene table it names (formatVersion 2: where
// each of the 13 districts of the machine's interior sits, in scene pixels:
// its rect, tier, sprite frame, name tag anchor and the energy road from the
// AI core to it; the core's base centre, radius and the area subagent drones
// fly in; the token wave's rect). Both are read over the network, so both are
// checked here before use. A sprite frame an atlas does not hold is simply
// not drawn (the DOM tags and the code-drawn data layers still show).
import type { StationCode } from "../station-catalog.ts";

/** The 13 places of the scene, as the scene table names them. */
export const PLACE_IDS = ["core", "user-desk", "orchestrator", "memory", "skills", "files", "mcp", "external", "security", "sandbox", "testing", "git", "monitoring"] as const;
export type PlaceId = (typeof PLACE_IDS)[number];

export type Point = readonly [number, number];

export interface Rect {
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
}

/** 1: main, 2: secondary, 3: background (smaller, dimmer while unused). */
export type Tier = 1 | 2 | 3;

export interface ScenePlace {
	readonly id: PlaceId;
	/** The district's box: its sprite fits inside (bottom centred), and it is the click area and the camera's focus box. */
	readonly rect: Rect;
	readonly tier: Tier;
	/** The atlas frame drawn in the rect. */
	readonly sprite: string;
	/** Name tag anchor. */
	readonly label: Point;
	/** The energy road from the core's base to the district (diagonals allowed); empty when none. */
	readonly route: readonly Point[];
}

export interface SceneSpace {
	readonly width: number;
	readonly height: number;
}

export interface SceneCore {
	/** The tower's base centre. */
	readonly centre: Point;
	readonly radius: number;
	/** Half axes of the area drones idle in around the base. */
	readonly orbit: Point;
}

export interface SceneTable {
	readonly space: SceneSpace;
	readonly measuredOn: string;
	readonly core: SceneCore;
	readonly wave: Rect;
	readonly places: Readonly<Record<PlaceId, ScenePlace>>;
}

export interface PlateFile {
	readonly file: string;
	readonly width: number;
	readonly height: number;
}

export interface AtlasEntry {
	readonly name: string;
	/** PixiJS spritesheet JSON. */
	readonly sheet: string;
	readonly image: string;
	readonly sprites: readonly string[];
}

export interface AssetTable {
	readonly space: SceneSpace;
	readonly plate: { readonly full: PlateFile; readonly half: PlateFile };
	/** The scene table's file name. */
	readonly scene: string;
	readonly atlases: readonly AtlasEntry[];
}

/** Everything the scene needs before drawing: file URLs resolved against the asset folder. */
export interface SceneAssets {
	readonly base: string;
	readonly table: AssetTable;
	readonly scene: SceneTable;
}

export const ASSET_TABLE_FILE = "observatory-assets.json";
export const SCENE_FORMAT = 2;

/** The asset folder under the app's base URL. */
export function assetBase(baseUrl: string): string {
	return `${baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`}observatory/`;
}

class AssetTableError extends Error {
	override name = "AssetTableError";
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function need<T>(ok: boolean, value: T, what: string): T {
	if (!ok) throw new AssetTableError(`observatory assets: ${what}`);
	return value;
}

function positive(v: unknown, what: string): number {
	return need(typeof v === "number" && Number.isFinite(v) && v > 0, v as number, `${what} is not a positive number`);
}

/** A file name the table points at: a plain name in the asset folder, never a path or a URL. */
function fileName(v: unknown, what: string): string {
	return need(typeof v === "string" && /^[\w.-]+$/.test(v) && !v.startsWith("."), v as string, `${what} is not a file name`);
}

function numbers(v: unknown, n: number, what: string): number[] {
	const ok = Array.isArray(v) && v.length === n && v.every((x) => typeof x === "number" && Number.isFinite(x));
	return need(ok, v as number[], `${what} is not a list of ${n} numbers`);
}

function point(v: unknown, space: SceneSpace, what: string): Point {
	const [x = 0, y = 0] = numbers(v, 2, what);
	need(x >= 0 && y >= 0 && x <= space.width && y <= space.height, null, `${what} is outside the plate`);
	return [x, y];
}

function rect(v: unknown, space: SceneSpace, what: string): Rect {
	const [x = 0, y = 0, w = 0, h = 0] = numbers(v, 4, what);
	need(w > 0 && h > 0, null, `${what} has no size`);
	need(x >= 0 && y >= 0 && x + w <= space.width && y + h <= space.height, null, `${what} is outside the plate`);
	return { x, y, w, h };
}

function space(v: unknown): SceneSpace {
	need(isObject(v), null, "space is missing");
	const s = v as Json;
	return { width: positive(s.width, "space.width"), height: positive(s.height, "space.height") };
}

function plateFile(v: unknown, what: string): PlateFile {
	need(isObject(v), null, `${what} is missing`);
	const p = v as Json;
	return { file: fileName(p.file, `${what}.file`), width: positive(p.width, `${what}.width`), height: positive(p.height, `${what}.height`) };
}

/** observatory-assets.json, checked. Throws on anything the renderer could not use. */
export function parseAssetTable(json: unknown): AssetTable {
	need(isObject(json), null, "the asset table is not an object");
	const t = json as Json;
	need(t.formatVersion === 1, null, `asset table format ${String(t.formatVersion)} is not 1`);
	need(isObject(t.plate), null, "plate is missing");
	const plate = t.plate as Json;
	need(Array.isArray(t.atlases), null, "atlases is not a list");
	const atlases = (t.atlases as unknown[]).map((a, i): AtlasEntry => {
		need(isObject(a), null, `atlases[${i}] is not an object`);
		const e = a as Json;
		const sprites = need(Array.isArray(e.sprites) && (e.sprites as unknown[]).every((s) => typeof s === "string"), e.sprites as string[], `atlases[${i}].sprites`);
		return { name: need(typeof e.name === "string", e.name as string, `atlases[${i}].name`), sheet: fileName(e.sheet, `atlases[${i}].sheet`), image: fileName(e.image, `atlases[${i}].image`), sprites };
	});
	return { space: space(t.space), plate: { full: plateFile(plate.full, "plate.full"), half: plateFile(plate.half, "plate.half") }, scene: fileName(t.scene, "scene"), atlases };
}

function isPlaceId(v: unknown): v is PlaceId {
	return typeof v === "string" && (PLACE_IDS as readonly string[]).includes(v);
}

function tier(v: unknown, what: string): Tier {
	return need(v === 1 || v === 2 || v === 3, v as Tier, `${what} is not 1, 2 or 3`);
}

/** The scene table (live-map-scene.json, format 2), checked: every place once, every rect and point on the plate. */
export function parseSceneTable(json: unknown): SceneTable {
	need(isObject(json), null, "the scene table is not an object");
	const t = json as Json;
	need(t.formatVersion === SCENE_FORMAT, null, `scene table format ${String(t.formatVersion)} is not ${SCENE_FORMAT}`);
	const sp = space(t.space);
	need(isObject(t.core), null, "core is missing");
	const c = t.core as Json;
	const [rx = 0, ry = 0] = numbers(c.orbit, 2, "core.orbit");
	need(rx > 0 && ry > 0, null, "core.orbit is not positive");
	const core: SceneCore = { centre: point(c.centre, sp, "core.centre"), radius: positive(c.radius, "core.radius"), orbit: [rx, ry] };
	const wave = rect(t.wave, sp, "wave");
	need(Array.isArray(t.places), null, "places is not a list");
	const places: Partial<Record<PlaceId, ScenePlace>> = {};
	for (const [i, raw] of (t.places as unknown[]).entries()) {
		need(isObject(raw), null, `places[${i}] is not an object`);
		const s = raw as Json;
		need(isPlaceId(s.id), null, `places[${i}].id ${String(s.id)} is not a place of the scene`);
		const id = s.id as PlaceId;
		need(places[id] === undefined, null, `${id} is listed twice`);
		need(typeof s.sprite === "string" && /^[a-z0-9-]+$/.test(s.sprite), null, `${id}.sprite is not a frame name`);
		need(Array.isArray(s.route), null, `${id}.route is not a list`);
		const route = (s.route as unknown[]).map((p, k) => point(p, sp, `${id}.route[${k}]`));
		need(route.length === 0 || route.length >= 2, null, `${id}.route has a single point`);
		places[id] = { id, rect: rect(s.rect, sp, `${id}.rect`), tier: tier(s.tier, `${id}.tier`), sprite: s.sprite as string, label: point(s.label, sp, `${id}.label`), route };
	}
	const missing = PLACE_IDS.filter((id) => places[id] === undefined);
	need(missing.length === 0, null, `places missing: ${missing.join(", ")}`);
	return { space: sp, measuredOn: typeof t.measuredOn === "string" ? t.measuredOn : "", core, wave, places: places as Record<PlaceId, ScenePlace> };
}

async function getJson(fetcher: typeof fetch, url: string, signal: AbortSignal | undefined): Promise<unknown> {
	const response = await fetcher(url, signal === undefined ? {} : { signal });
	if (!response.ok) throw new AssetTableError(`observatory assets: ${url} answered ${response.status}`);
	return response.json();
}

/** The asset table and the scene table it names, fetched from `base` and checked. */
export async function loadSceneAssets(base: string, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<SceneAssets> {
	const table = parseAssetTable(await getJson(fetcher, base + ASSET_TABLE_FILE, signal));
	const scene = parseSceneTable(await getJson(fetcher, base + table.scene, signal));
	need(scene.space.width === table.space.width && scene.space.height === table.space.height, null, "the scene table and the asset table disagree on the plate size");
	return { base, table, scene };
}

/** What decides the plate's size. */
export interface PlateConditions {
	/** gl.MAX_TEXTURE_SIZE; null when unknown (no WebGL context, the static view). */
	readonly maxTextureSize: number | null;
	/** The frame's width in CSS pixels. */
	readonly frameWidth: number;
	/** navigator.connection.saveData. */
	readonly saveData: boolean;
}

/** The frame must be at least this wide for the full plate. */
export const FULL_PLATE_MIN_WIDTH = 900;

/** The full plate only when the GPU takes it, the frame is wide and the user does not save data; the half one otherwise. */
export function choosePlate(table: AssetTable, c: PlateConditions): PlateFile {
	const gpuTakesIt = c.maxTextureSize === null || c.maxTextureSize >= table.plate.full.width;
	return gpuTakesIt && c.frameWidth >= FULL_PLATE_MIN_WIDTH && !c.saveData ? table.plate.full : table.plate.half;
}

/** How the plate sits in a frame: scaled to fit whole (contain) and centred. */
export interface SceneFit {
	/** CSS pixels per plate pixel. */
	readonly scale: number;
	readonly offsetX: number;
	readonly offsetY: number;
}

export function fitScene(s: SceneSpace, frame: { readonly width: number; readonly height: number }): SceneFit {
	if (frame.width <= 0 || frame.height <= 0) return { scale: 0, offsetX: 0, offsetY: 0 };
	const scale = Math.min(frame.width / s.width, frame.height / s.height);
	return { scale, offsetX: (frame.width - s.width * scale) / 2, offsetY: (frame.height - s.height * scale) / 2 };
}

/** A plate point in the frame's CSS pixels. */
export function project(p: Point, fit: SceneFit): { x: number; y: number } {
	return { x: fit.offsetX + p[0] * fit.scale, y: fit.offsetY + p[1] * fit.scale };
}

/** A frame point (CSS pixels) on the plate. */
export function unproject(x: number, y: number, fit: SceneFit): Point {
	if (fit.scale === 0) return [0, 0];
	return [(x - fit.offsetX) / fit.scale, (y - fit.offsetY) / fit.scale];
}

export function insideRect(p: Point, r: Rect): boolean {
	return p[0] >= r.x && p[0] <= r.x + r.w && p[1] >= r.y && p[1] <= r.y + r.h;
}

/** Places tried by a click, small and front ones first; the drones' area (orchestrator) last, as an ellipse around the core's base. */
const HIT_ORDER: readonly PlaceId[] = ["security", "user-desk", "monitoring", "memory", "skills", "files", "sandbox", "testing", "git", "mcp", "external", "core"];

/** The place at a plate point, or null. */
export function placeAt(scene: SceneTable, p: Point): PlaceId | null {
	for (const id of HIT_ORDER) if (insideRect(p, scene.places[id].rect)) return id;
	const [cx, cy] = scene.core.centre;
	const [rx, ry] = scene.core.orbit;
	const dx = (p[0] - cx) / rx;
	const dy = (p[1] - cy) / ry;
	return dx * dx + dy * dy <= 1 ? "orchestrator" : null;
}

/** The place a station's things happen at; the three places without a station (input port, permission lock, context reservoir) take what the scene sends them. */
export const STATION_PLACE: Readonly<Record<StationCode, PlaceId>> = {
	CORE: "core",
	ORCHESTRATOR: "orchestrator",
	FILES: "files",
	MEMORY: "memory",
	SKILLS: "skills",
	MCP: "mcp",
	EXTERNAL: "external",
	SANDBOX: "sandbox",
	TESTING: "testing",
	GIT: "git",
};
