// The Live Map's assets as the art pipeline publishes them
// (hoandat-app/tools/observatory-art/build-observatory-manifest.mjs, copied
// into public/observatory/): the asset table observatory-assets.json (the
// plate in two sizes, the scene table, sprite atlases, all with
// content-hashed names) and the scene table it names (where each of the 13
// places of the scene sits on the plate, in the plate's 2560x1920 pixels).
// Both are read over the network, so both are checked here before use. Until
// the real plate and sprites are drawn the table points at a stand-in plate
// cut from concept-04 and lists no atlas; the renderer then draws the moving
// pieces itself. Re-running the pipeline and copying its dist/ swaps them in
// with no code change.
import type { StationCode } from "../station-catalog.ts";

/** The 13 places of the scene, as the scene table names them. */
export const PLACE_IDS = ["core", "user-desk", "orchestrator", "memory", "skills", "files", "mcp", "external", "security", "sandbox", "testing", "git", "monitoring"] as const;
export type PlaceId = (typeof PLACE_IDS)[number];

export type Point = readonly [number, number];

export interface SceneOverlay {
	readonly points: readonly Point[];
	readonly polygon: readonly Point[];
}

export interface ScenePlace {
	readonly id: PlaceId;
	/** Click outline. */
	readonly hit: readonly Point[];
	/** Name tag anchor. */
	readonly label: Point;
	/** Where a drone (or a beam) stops. */
	readonly droneTarget: Point;
	/** Up to 4 waiting spots. */
	readonly queue: readonly Point[];
	/** From inside the core to droneTarget; empty for the core itself. */
	readonly flightPath: readonly Point[];
	readonly overlays: Readonly<Record<string, SceneOverlay>>;
}

export interface SceneSpace {
	readonly width: number;
	readonly height: number;
}

export interface SceneTable {
	readonly space: SceneSpace;
	/** "concept-04" until the plate is approved and the table measured on it. */
	readonly measuredOn: string;
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

function point(v: unknown, space: SceneSpace, what: string): Point {
	const ok = Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isFinite(n));
	need(ok, null, `${what} is not a point`);
	const [x, y] = v as [number, number];
	need(x >= 0 && y >= 0 && x <= space.width && y <= space.height, null, `${what} is outside the plate`);
	return [x, y];
}

function points(v: unknown, space: SceneSpace, what: string): Point[] {
	need(v === undefined || Array.isArray(v), null, `${what} is not a list`);
	return ((v as unknown[] | undefined) ?? []).map((p, i) => point(p, space, `${what}[${i}]`));
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

/** The scene table (live-map-scene.json), checked: every place once, every point on the plate. */
export function parseSceneTable(json: unknown): SceneTable {
	need(isObject(json), null, "the scene table is not an object");
	const t = json as Json;
	need(t.formatVersion === 1, null, `scene table format ${String(t.formatVersion)} is not 1`);
	const sp = space(t.space);
	need(Array.isArray(t.stations), null, "stations is not a list");
	const places: Partial<Record<PlaceId, ScenePlace>> = {};
	for (const [i, raw] of (t.stations as unknown[]).entries()) {
		need(isObject(raw), null, `stations[${i}] is not an object`);
		const s = raw as Json;
		need(isPlaceId(s.id), null, `stations[${i}].id ${String(s.id)} is not a place of the scene`);
		const id = s.id as PlaceId;
		need(places[id] === undefined, null, `${id} is listed twice`);
		const hit = points(s.hit, sp, `${id}.hit`);
		need(hit.length >= 3, null, `${id}.hit has fewer than 3 points`);
		const overlays: Record<string, SceneOverlay> = {};
		if (s.overlays !== undefined) {
			need(isObject(s.overlays), null, `${id}.overlays is not an object`);
			for (const [name, o] of Object.entries(s.overlays as Json)) {
				need(isObject(o), null, `${id}.overlays.${name} is not an object`);
				const ov = o as Json;
				overlays[name] = { points: points(ov.points, sp, `${id}.overlays.${name}.points`), polygon: points(ov.polygon, sp, `${id}.overlays.${name}.polygon`) };
			}
		}
		places[id] = {
			id,
			hit,
			label: point(s.label, sp, `${id}.label`),
			droneTarget: point(s.droneTarget, sp, `${id}.droneTarget`),
			queue: points(s.queue, sp, `${id}.queue`).slice(0, 4),
			flightPath: points(s.flightPath, sp, `${id}.flightPath`),
			overlays,
		};
	}
	const missing = PLACE_IDS.filter((id) => places[id] === undefined);
	need(missing.length === 0, null, `places missing: ${missing.join(", ")}`);
	return { space: sp, measuredOn: typeof t.measuredOn === "string" ? t.measuredOn : "", places: places as Record<PlaceId, ScenePlace> };
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

/** The 2560 plate only when the GPU takes it, the frame is wide and the user does not save data; the 1280 one otherwise. */
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

/** Whether `p` lies inside `polygon` (even-odd rule). */
export function insidePolygon(p: Point, polygon: readonly Point[]): boolean {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const a = polygon[i];
		const b = polygon[j];
		if (a === undefined || b === undefined) continue;
		if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
	}
	return inside;
}

/** The middle of a set of points (a polygon's vertices); [0, 0] for none. */
export function centreOf(pts: readonly Point[]): Point {
	if (pts.length === 0) return [0, 0];
	let x = 0;
	let y = 0;
	for (const [px, py] of pts) {
		x += px;
		y += py;
	}
	return [x / pts.length, y / pts.length];
}

/** The place a station's things happen at; the three places without a station (user desk, gateway, monitoring) take the events the prop table sends them. */
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
