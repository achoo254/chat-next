import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { BrandConfig } from "./config.ts";
import { REPO_ROOT } from "./config.ts";

/** Which brand asset a raster icon is drawn from. */
export type IconSource = "icon" | "iconMaskable";

/** A PNG the generator draws from a brand SVG into packages/brand/generated/icons/. */
export interface RasterIcon {
	/** File name under generated/icons/ and the URL path the web app serves it at. */
	readonly file: string;
	readonly source: IconSource;
	readonly size: number;
}

/**
 * PNG icons of the web app. The rounded icon serves browsers ("any"); the
 * full-bleed maskable icon serves launchers that crop to their own shape and
 * iOS, which rounds the Apple touch icon itself.
 */
export const RASTER_ICONS: readonly RasterIcon[] = [
	{ file: "icon-192.png", source: "icon", size: 192 },
	{ file: "icon-512.png", source: "icon", size: 512 },
	{ file: "icon-maskable-192.png", source: "iconMaskable", size: 192 },
	{ file: "icon-maskable-512.png", source: "iconMaskable", size: 512 },
	{ file: "apple-touch-icon.png", source: "iconMaskable", size: 180 },
];

/** Sizes packed into favicon.ico, for browsers without SVG favicons. */
export const FAVICON_ICO_SIZES: readonly number[] = [16, 32, 48];

export const FAVICON_ICO = "favicon.ico";
/** URL path of the SVG favicon (a copy of the brand icon). */
export const FAVICON_SVG = "icon.svg";
/** Records which brand SVGs the generated icons were drawn from. */
export const ICONS_SOURCE_FILE = "icons-source.json";

export const GENERATED_ICONS_DIR = new URL("../generated/icons/", import.meta.url);

/** One file the web app serves at the site root, and where it comes from. */
export interface WebIconFile {
	/** URL path without the leading slash. */
	readonly path: string;
	readonly file: URL;
}

/** Every icon file the web app serves, with its source on disk. */
export function webIconFiles(brand: BrandConfig): readonly WebIconFile[] {
	return [
		{ path: FAVICON_SVG, file: new URL(brand.icon, REPO_ROOT) },
		{ path: FAVICON_ICO, file: new URL(FAVICON_ICO, GENERATED_ICONS_DIR) },
		...RASTER_ICONS.map((icon) => ({ path: icon.file, file: new URL(icon.file, GENERATED_ICONS_DIR) })),
	];
}

/** Manifest icon entries, matching webIconFiles. */
export function manifestIcons(): readonly Record<string, string>[] {
	return [
		{ src: `/${FAVICON_SVG}`, sizes: "any", type: "image/svg+xml", purpose: "any" },
		...RASTER_ICONS.filter((icon) => icon.file.startsWith("icon-")).map((icon) => ({
			src: `/${icon.file}`,
			sizes: `${icon.size}x${icon.size}`,
			type: "image/png",
			purpose: icon.source === "iconMaskable" ? "maskable" : "any",
		})),
	];
}

/**
 * sha256 of each brand SVG the raster icons come from. The generator stores
 * it next to the icons; a test compares it with the current files, so an
 * edited logo without `pnpm brand:gen` fails instead of shipping stale PNGs.
 */
export function iconSourceHashes(brand: BrandConfig): Record<IconSource, string> {
	const hash = (path: string) => createHash("sha256").update(readFileSync(new URL(path, REPO_ROOT))).digest("hex");
	return { icon: hash(brand.icon), iconMaskable: hash(brand.iconMaskable) };
}

export interface IcoImage {
	readonly size: number;
	readonly png: Uint8Array;
}

/**
 * Packs PNG images into an .ico file (PNG-compressed entries, supported by
 * every browser that reads favicon.ico). Sizes must be 1 to 256 pixels.
 */
export function encodeIco(images: readonly IcoImage[]): Uint8Array {
	if (images.length === 0) throw new Error("encodeIco: no images");
	const HEADER = 6;
	const ENTRY = 16;
	let offset = HEADER + ENTRY * images.length;
	const total = offset + images.reduce((sum, image) => sum + image.png.byteLength, 0);
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	view.setUint16(0, 0, true); // reserved
	view.setUint16(2, 1, true); // type: icon
	view.setUint16(4, images.length, true);
	images.forEach((image, index) => {
		if (!Number.isInteger(image.size) || image.size < 1 || image.size > 256) {
			throw new Error(`encodeIco: size ${image.size} is outside 1..256`);
		}
		const entry = HEADER + ENTRY * index;
		// Width and height 256 are written as 0.
		view.setUint8(entry, image.size % 256);
		view.setUint8(entry + 1, image.size % 256);
		view.setUint8(entry + 2, 0); // palette colours
		view.setUint8(entry + 3, 0); // reserved
		view.setUint16(entry + 4, 1, true); // colour planes
		view.setUint16(entry + 6, 32, true); // bits per pixel
		view.setUint32(entry + 8, image.png.byteLength, true);
		view.setUint32(entry + 12, offset, true);
		out.set(image.png, offset);
		offset += image.png.byteLength;
	});
	return out;
}
