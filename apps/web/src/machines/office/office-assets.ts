// The baked pictures of the 2D view (public/office/office-assets.json, made
// with the 3D assets): one picture of the whole plan per screen size, by day
// and by night, and where every anchor of the layout lands on it, in percent. The
// file carries two SHA-256 of the layout: `bakeSha256` of the parts the shells,
// lightmaps, props and pictures were baked from (rooms, walls, doors, furniture,
// decor, camera; not anchors or walkways), and `anchorsSha256` of the anchors'
// places. When the baked parts changed since, the pictures no longer match and
// the views fall back (plain background in 2D, placeholder blocks in 3D) instead
// of putting people beside their chairs; when only the anchors moved and their
// 2D places were not projected again (project-anchors-2d.mjs), the 2D view keeps
// its pictures and projects the anchors itself with the same camera formula. Both hashes are over a fixed JSON text of
// those parts (bakeInput, anchorsInput), the same as tools/office-art computes.
import { arrayOf, isRecord, numberOf, stringOf, type Parsed } from "./office-json.ts";
import { OFFICE_LAYOUT_TEXT, type OfficeLayout } from "./office-layout.ts";
import { projectPoint, type ScreenSize } from "./office-geometry.ts";

export const ASSETS_FORMAT_VERSION = 3;
/** Where the assets are served from. */
export const ASSETS_BASE = "/office/";

export interface AssetView {
	readonly width: number;
	readonly height: number;
	/** File names under ASSETS_BASE. */
	readonly day: string;
	readonly night: string;
	/** Anchor id → [x, y] in percent of the picture from its top left. */
	readonly anchors: ReadonlyMap<string, readonly [number, number]>;
}

export interface OfficeAssets {
	/** The plan's picture for each screen size. */
	readonly views: Readonly<Record<ScreenSize, AssetView>>;
}

/** The layout's parts a bake is made from, in a fixed order (tools/office-art/office-art-io.mjs bakeInput: keep the two the same). */
const BAKE_KEYS = ["footprint", "wallHeight", "lowWallHeight", "defaultCamera", "zones", "rooms", "circulation", "glass", "walls", "lowWalls", "windows", "doors", "props", "smallProps", "decor"] as const;

/** Furniture without the anchor tags (which say whose seat it is, not how it is drawn). */
function untagged(value: unknown): unknown {
	if (!Array.isArray(value)) return null;
	return value.map((item: unknown) => {
		if (!isRecord(item)) return item;
		const { anchor: _anchor, ...rest } = item;
		return rest;
	});
}

/** The baked parts of a layout as one JSON text. */
export function bakeInput(layout: unknown): string {
	const rec = isRecord(layout) ? layout : {};
	return JSON.stringify(BAKE_KEYS.map((key) => [key, key === "props" || key === "smallProps" ? untagged(rec[key]) : (rec[key] ?? null)]));
}

/** The anchors' places as one JSON text: [id, x, z] of each. */
export function anchorsInput(layout: unknown): string {
	const rec = isRecord(layout) ? layout : {};
	return JSON.stringify(arrayOf(rec.anchors).map((a) => (isRecord(a) ? [a.id, a.x, a.z] : null)));
}

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 (hex) of the layout's baked parts. */
export async function bakeHash(text: string = OFFICE_LAYOUT_TEXT): Promise<string> {
	return sha256(bakeInput(JSON.parse(text)));
}

/** SHA-256 (hex) of the layout's anchor places. */
export async function anchorsHash(text: string = OFFICE_LAYOUT_TEXT): Promise<string> {
	return sha256(anchorsInput(JSON.parse(text)));
}

/** The two hashes an asset file must carry for this build's layout. */
export interface LayoutHashes {
	readonly bake: string;
	readonly anchors: string;
}

export async function layoutHashes(text: string = OFFICE_LAYOUT_TEXT): Promise<LayoutHashes> {
	return { bake: await bakeHash(text), anchors: await anchorsHash(text) };
}

/** A bare file name in the assets folder: no path, and no leading dot (so neither `..` nor a hidden file). */
const SAFE_FILE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

function parseView(value: unknown, where: string, anchorIds: readonly string[], errors: string[]): AssetView | null {
	if (!isRecord(value)) {
		errors.push(`${where} is missing`);
		return null;
	}
	const width = numberOf(value.width);
	const height = numberOf(value.height);
	const day = stringOf(value.day);
	const night = stringOf(value.night);
	if (width === null || width <= 0 || height === null || height <= 0) errors.push(`${where} needs a positive width and height`);
	if (!SAFE_FILE.test(day) || !SAFE_FILE.test(night)) errors.push(`${where} needs day and night file names`);
	const raw = isRecord(value.anchors) ? value.anchors : {};
	const anchors = new Map<string, readonly [number, number]>();
	const missing: string[] = [];
	for (const id of anchorIds) {
		const point = arrayOf(raw[id]).map(numberOf);
		const x = point[0];
		const y = point[1];
		if (point.length !== 2 || x === null || x === undefined || y === null || y === undefined) missing.push(id);
		else anchors.set(id, [x, y]);
	}
	if (missing.length > 0) errors.push(`${where} has no position for ${missing.join(", ")}`);
	return { width: width ?? 1, height: height ?? 1, day, night, anchors };
}

/** Every anchor through the layout's camera for a screen size, rounded like the shipped file (hundredths of a percent). */
function projectedAnchors(layout: OfficeLayout, size: ScreenSize): Map<string, readonly [number, number]> {
	const round = (n: number): number => Math.round(n * 100) / 100;
	return new Map(
		layout.anchors.map((a) => {
			const [x, y] = projectPoint(layout.camera, layout.camera.views[size], a.x, 0, a.z);
			return [a.id, [round(x), round(y)] as const];
		}),
	);
}

/**
 * Checks an asset file against the layout it must have been baked from (`hashes`: layoutHashes of that layout). Anchors
 * moved since their 2D places were projected keep the pictures and are projected here (logged).
 */
export function parseOfficeAssets(json: unknown, layout: OfficeLayout, hashes: LayoutHashes): Parsed<OfficeAssets> {
	if (!isRecord(json)) return { ok: false, errors: ["the asset file is not a JSON object"] };
	if (json.formatVersion !== ASSETS_FORMAT_VERSION) return { ok: false, errors: [`asset format version ${String(json.formatVersion)}, this app reads ${ASSETS_FORMAT_VERSION}`] };
	if (json.bakeSha256 !== hashes.bake) return { ok: false, errors: ["the assets were baked from another layout (bakeSha256 differs): bake them again"] };
	const errors: string[] = [];
	const views = isRecord(json.views) ? json.views : {};
	const anchorsCurrent = json.anchorsSha256 === hashes.anchors;
	if (!anchorsCurrent) console.warn("office: the anchors moved since their 2D places were projected (anchorsSha256 differs): run project-anchors-2d.mjs; projecting them here");
	const ids = anchorsCurrent ? layout.anchors.map((a) => a.id) : [];
	const desktop = parseView(views.desktop, "desktop view", ids, errors);
	const phone = parseView(views.phone, "phone view", ids, errors);
	if (errors.length > 0 || desktop === null || phone === null) return { ok: false, errors };
	if (anchorsCurrent) return { ok: true, value: { views: { desktop, phone } } };
	return { ok: true, value: { views: { desktop: { ...desktop, anchors: projectedAnchors(layout, "desktop") }, phone: { ...phone, anchors: projectedAnchors(layout, "phone") } } } };
}

/** Fetches and checks the shipped asset file; any failure says why (the views fall back). */
export async function loadOfficeAssets(layout: OfficeLayout, fetcher: typeof fetch = fetch): Promise<Parsed<OfficeAssets>> {
	try {
		const response = await fetcher(`${ASSETS_BASE}office-assets.json`, { cache: "no-cache" });
		if (!response.ok) return { ok: false, errors: [`office-assets.json: HTTP ${response.status}`] };
		const json: unknown = await response.json();
		return parseOfficeAssets(json, layout, await layoutHashes());
	} catch (err) {
		return { ok: false, errors: [`office-assets.json: ${err instanceof Error ? err.message : String(err)}`] };
	}
}
