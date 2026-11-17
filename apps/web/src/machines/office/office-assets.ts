// The baked pictures of the 2D view (public/office/office-assets.json, made
// with the 3D assets): one picture of the whole plan per screen size, by day
// and by night, and where every anchor of the layout lands on it, in percent. The
// file carries the SHA-256 of the layout it was baked from: when the layout
// changed since, the pictures no longer match it and the views fall back
// (plain background in 2D, placeholder blocks in 3D) instead of putting
// people beside their chairs. The hash is over the layout's text with LF line
// ends, so a checkout's line endings do not matter.
import { arrayOf, isRecord, numberOf, stringOf, type Parsed } from "./office-json.ts";
import { OFFICE_LAYOUT_TEXT, type OfficeLayout } from "./office-layout.ts";
import type { ScreenSize } from "./office-geometry.ts";

export const ASSETS_FORMAT_VERSION = 2;
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

/** SHA-256 (hex) of a layout's text with LF line ends. */
export async function layoutHash(text: string = OFFICE_LAYOUT_TEXT): Promise<string> {
	const bytes = new TextEncoder().encode(text.replace(/\r\n/g, "\n"));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
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

/** Checks an asset file against the layout it must have been baked from (`hash`: layoutHash of that layout). */
export function parseOfficeAssets(json: unknown, layout: OfficeLayout, hash: string): Parsed<OfficeAssets> {
	if (!isRecord(json)) return { ok: false, errors: ["the asset file is not a JSON object"] };
	if (json.formatVersion !== ASSETS_FORMAT_VERSION) return { ok: false, errors: [`asset format version ${String(json.formatVersion)}, this app reads ${ASSETS_FORMAT_VERSION}`] };
	if (json.layoutSha256 !== hash) return { ok: false, errors: ["the assets were baked from another layout (layoutSha256 differs): bake them again"] };
	const errors: string[] = [];
	const views = isRecord(json.views) ? json.views : {};
	const ids = layout.anchors.map((a) => a.id);
	const desktop = parseView(views.desktop, "desktop view", ids, errors);
	const phone = parseView(views.phone, "phone view", ids, errors);
	if (errors.length > 0 || desktop === null || phone === null) return { ok: false, errors };
	return { ok: true, value: { views: { desktop, phone } } };
}

/** Fetches and checks the shipped asset file; any failure says why (the views fall back). */
export async function loadOfficeAssets(layout: OfficeLayout, fetcher: typeof fetch = fetch): Promise<Parsed<OfficeAssets>> {
	try {
		const response = await fetcher(`${ASSETS_BASE}office-assets.json`, { cache: "no-cache" });
		if (!response.ok) return { ok: false, errors: [`office-assets.json: HTTP ${response.status}`] };
		const json: unknown = await response.json();
		return parseOfficeAssets(json, layout, await layoutHash());
	} catch (err) {
		return { ok: false, errors: [`office-assets.json: ${err instanceof Error ? err.message : String(err)}`] };
	}
}
