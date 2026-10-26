/**
 * The app icons, launch screens and Play listing art of the iOS and Android
 * apps (apps/mobile), drawn from the brand SVGs and colours by pnpm brand:gen
 * with Playwright's Chromium, so a new logo or colour never leaves the
 * Capacitor defaults or a stale picture behind:
 *
 * - iOS: the single 1024 px App Store icon (opaque: App Store Connect refuses
 *   an icon with an alpha channel) and the launch screen image, light and dark;
 * - Android: the adaptive icon (background, foreground, monochrome for themed
 *   icons on Android 13+), the legacy square and round icons, and the launch
 *   screen of Android 7 to 11 (brand background, logo in the middle; Android
 *   12+ draws its own from the adaptive icon on the same colour);
 * - Google Play: the 1024 × 500 feature graphic.
 *
 * A vector logo is split into layers by the classes of brand/icon.svg the web
 * app uses (logo-bg, logo-bubble, logo-dot): hiding logo-bg leaves the
 * artwork. A logo without them (a picture, such as artwork embedded as an
 * <image>) cannot be split: the adaptive foreground is then the full-bleed
 * maskable icon over a brand-colour background, and the themed (monochrome)
 * layer is brand/icon-monochrome.svg, the symbol's white silhouette framed
 * like the maskable icon. Without that file Android 13+ shows the icon in
 * its own colours.
 *
 * cap sync copies the web bundle and plugin lists only, never these files.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";

/** Densities of Android resources: directory suffix and pixels per dp. */
export const ANDROID_DENSITIES = [
	{ name: "mdpi", scale: 1 },
	{ name: "hdpi", scale: 1.5 },
	{ name: "xhdpi", scale: 2 },
	{ name: "xxhdpi", scale: 3 },
	{ name: "xxxhdpi", scale: 4 },
] as const;

/** Paths inside apps/mobile. */
export const IOS_ASSETS = "ios/App/App/Assets.xcassets";
export const IOS_APP_ICON = `${IOS_ASSETS}/AppIcon.appiconset/AppIcon-512@2x.png`;
export const IOS_SPLASH_DIR = `${IOS_ASSETS}/Splash.imageset`;
export const ANDROID_RES = "android/app/src/main/res";

/** The App Store icon, and the side of the square iOS launch image (aspect-filled to the screen). */
const IOS_ICON_SIZE = 1024;
const IOS_SPLASH_SIZE = 2732;
/** The logo's share of the iOS launch image: about 140 pt tall on a 6.9" iPhone. */
const IOS_SPLASH_LOGO_SHARE = 0.15;

/** Legacy launcher icon, adaptive icon layer and Android 7–11 launch logo, in dp. */
const LEGACY_ICON_DP = 48;
const ADAPTIVE_DP = 108;
const SPLASH_LOGO_DP = 120;
/**
 * The artwork's share of an adaptive layer. The maskable icon draws it at 80 %
 * so it stays inside the maskable safe circle (radius 40 % of the canvas);
 * mapping that circle onto the adaptive safe zone (radius 33 of 108 dp) puts
 * the artwork of brand/icon.svg at 0.8 × 33 / (0.4 × 108) of the layer.
 */
const ADAPTIVE_ART_SHARE = (0.8 * 33) / (0.4 * ADAPTIVE_DP);
/** The full-bleed maskable icon's share of an adaptive layer: its safe circle lands on the adaptive safe zone. */
const ADAPTIVE_MASKABLE_SHARE = 33 / (0.4 * ADAPTIVE_DP);

export const FEATURE_GRAPHIC = { width: 1024, height: 500 } as const;

const REQUIRED_CLASSES = ["logo-bg", "logo-bubble", "logo-dot"] as const;

/**
 * The themed-icon silhouette of a picture logo, next to brand/icon.svg (not a
 * brand.config.json field: the shared schema has none). Derived once from the
 * AI master: white symbol on transparent, the same framing as the maskable icon.
 */
export const MONOCHROME_ICON = "brand/icon-monochrome.svg";

/** brand/icon-monochrome.svg under the repository root, or null when there is none. */
export function readMonochromeIcon(root: string): string | null {
	const file = join(root, MONOCHROME_ICON);
	return existsSync(file) ? readFileSync(file, "utf8") : null;
}

export interface NativeBrand {
	readonly appName: string;
	readonly description: string;
	readonly colors: { readonly primary: string; readonly background: string; readonly backgroundDark: string };
	/** brand/icon.svg: the rounded icon, with the logo-* classes. */
	readonly iconSvg: string;
	/** brand/icon-maskable.svg: full bleed, artwork inside the safe circle. */
	readonly maskableSvg: string;
	/** brand/icon-monochrome.svg (see MONOCHROME_ICON), or null: the themed layer of a picture logo. */
	readonly monochromeSvg: string | null;
}

/** A logo drawn centred on a picture. */
interface Logo {
	readonly svg: string;
	/** Side in pixels. */
	readonly size: number;
	/** Clipped to a circle (legacy round launcher icon). */
	readonly round?: boolean;
	/** White where the logo is light, transparent where it is dark or empty (themed icon). */
	readonly mono?: boolean;
}

/** One PNG to draw. `background` null leaves it transparent; a colour makes it opaque (RGB, no alpha). */
export interface NativePicture {
	/** Path under apps/mobile (or the repository root for store art, see writeNativeBrandFiles). */
	readonly file: string;
	readonly width: number;
	readonly height: number;
	readonly background: string | null;
	readonly logo?: Logo;
	/** Raw HTML instead of a logo (the feature graphic). */
	readonly html?: string;
}

/** Whether brand/icon.svg has the classes that split it into adaptive icon layers. */
export function isLayeredIcon(iconSvg: string): boolean {
	return REQUIRED_CLASSES.every((name) => new RegExp(`class="[^"]*\\b${name}\\b`).test(iconSvg));
}

/** brand/icon.svg with extra CSS: the way to hide or recolour its layers. */
export function styledIcon(iconSvg: string, css: string): string {
	for (const name of REQUIRED_CLASSES) {
		if (!new RegExp(`class="[^"]*\\b${name}\\b`).test(iconSvg)) {
			throw new Error(`brand native: brand/icon.svg has no element with class "${name}" (needed to split the icon into layers)`);
		}
	}
	const open = /<svg\b[^>]*>/.exec(iconSvg);
	if (open === null) throw new Error("brand native: brand/icon.svg has no <svg> element");
	const at = open.index + open[0].length;
	return `${iconSvg.slice(0, at)}<style>${css}</style>${iconSvg.slice(at)}`;
}

const xmlHeader = (what: string) =>
	`<?xml version="1.0" encoding="utf-8"?>\n<!-- Generated by pnpm brand:gen (apps/web/scripts/brand-native.ts) from ${what}. Do not edit. -->\n`;

function adaptiveIcon(monochrome: boolean): string {
	const themed = monochrome ? `\n    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>` : "";
	return `${xmlHeader("the brand icon")}<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>${themed}
</adaptive-icon>
`;
}

/** Android 7–11 launch screen: the brand background with the logo in the middle, never stretched. */
const SPLASH_DRAWABLE = `${xmlHeader("the brand icon")}<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <item android:drawable="@color/splash_background"/>
    <item>
        <bitmap android:gravity="center" android:src="@drawable/splash_logo"/>
    </item>
</layer-list>
`;

function colorsXml(background: string): string {
	if (!/^#[0-9a-fA-F]{6}$/.test(background)) throw new Error(`brand native: colour ${background} is not #rrggbb`);
	return `${xmlHeader("brand.config.json colors")}<resources>
    <color name="splash_background">${background.toUpperCase()}</color>
</resources>
`;
}

const SPLASH_CONTENTS = `${JSON.stringify(
	{
		images: [
			{ filename: "splash-2732x2732.png", idiom: "universal" },
			{ appearances: [{ appearance: "luminosity", value: "dark" }], filename: "splash-2732x2732-dark.png", idiom: "universal" },
		],
		info: { author: "xcode", version: 1 },
	},
	null,
	2,
)}\n`;

/** Whether the adaptive icon has a themed (monochrome) layer: split from a layered logo, or the silhouette of a picture one. */
export function hasMonochromeLayer(brand: NativeBrand): boolean {
	return isLayeredIcon(brand.iconSvg) || brand.monochromeSvg !== null;
}

/** Text files under apps/mobile: Android resources and the iOS launch image set. */
export function nativeTextFiles(brand: NativeBrand): Record<string, string> {
	const adaptive = adaptiveIcon(hasMonochromeLayer(brand));
	return {
		[`${ANDROID_RES}/mipmap-anydpi-v26/ic_launcher.xml`]: adaptive,
		[`${ANDROID_RES}/mipmap-anydpi-v26/ic_launcher_round.xml`]: adaptive,
		[`${ANDROID_RES}/drawable/splash.xml`]: SPLASH_DRAWABLE,
		[`${ANDROID_RES}/values/brand_colors.xml`]: colorsXml(brand.colors.background),
		[`${ANDROID_RES}/values-night/brand_colors.xml`]: colorsXml(brand.colors.backgroundDark),
		[`${IOS_SPLASH_DIR}/Contents.json`]: SPLASH_CONTENTS,
	};
}

/** Every PNG of the iOS and Android projects, with how to draw it. */
export function nativePictures(brand: NativeBrand): NativePicture[] {
	const { iconSvg, maskableSvg, colors } = brand;
	const layered = isLayeredIcon(iconSvg);
	const splashLogo = Math.round(IOS_SPLASH_SIZE * IOS_SPLASH_LOGO_SHARE);
	const pictures: NativePicture[] = [
		// iOS rounds the corners itself: the full-bleed icon, flattened on the brand colour.
		{ file: IOS_APP_ICON, width: IOS_ICON_SIZE, height: IOS_ICON_SIZE, background: colors.primary, logo: { svg: maskableSvg, size: IOS_ICON_SIZE } },
		...(
			[
				["splash-2732x2732.png", colors.background],
				["splash-2732x2732-dark.png", colors.backgroundDark],
			] as const
		).map(([name, background]) => ({
			file: `${IOS_SPLASH_DIR}/${name}`,
			width: IOS_SPLASH_SIZE,
			height: IOS_SPLASH_SIZE,
			background,
			logo: { svg: iconSvg, size: splashLogo },
		})),
	];
	for (const { name, scale } of ANDROID_DENSITIES) {
		const mipmap = `${ANDROID_RES}/mipmap-${name}`;
		const legacy = Math.round(LEGACY_ICON_DP * scale);
		const layer = Math.round(ADAPTIVE_DP * scale);
		const splash = Math.round(SPLASH_LOGO_DP * scale);
		pictures.push(
			{ file: `${mipmap}/ic_launcher.png`, width: legacy, height: legacy, background: null, logo: { svg: iconSvg, size: legacy } },
			{ file: `${mipmap}/ic_launcher_round.png`, width: legacy, height: legacy, background: null, logo: { svg: maskableSvg, size: legacy, round: true } },
			...adaptiveLayers(brand, mipmap, layer, layered),
			{ file: `${ANDROID_RES}/drawable-${name}/splash_logo.png`, width: splash, height: splash, background: null, logo: { svg: iconSvg, size: splash } },
		);
	}
	return pictures;
}

/** The adaptive icon layers of one density: split from a layered logo, or the whole maskable picture on the brand colour with its silhouette as the themed layer. */
function adaptiveLayers(brand: NativeBrand, mipmap: string, layer: number, layered: boolean): NativePicture[] {
	const { iconSvg, maskableSvg, colors } = brand;
	const background = `${mipmap}/ic_launcher_background.png`;
	const foreground = `${mipmap}/ic_launcher_foreground.png`;
	if (!layered) {
		const size = Math.round(layer * ADAPTIVE_MASKABLE_SHARE);
		const themed: NativePicture[] =
			brand.monochromeSvg === null
				? []
				: [{ file: `${mipmap}/ic_launcher_monochrome.png`, width: layer, height: layer, background: null, logo: { svg: brand.monochromeSvg, size } }];
		return [
			{ file: background, width: layer, height: layer, background: colors.primary },
			{ file: foreground, width: layer, height: layer, background: null, logo: { svg: maskableSvg, size } },
			...themed,
		];
	}
	const art = styledIcon(iconSvg, ".logo-bg{display:none}");
	const backgroundLayer = styledIcon(iconSvg, ".logo-bubble,.logo-dot{display:none}.logo-bg{rx:0}");
	const mono = styledIcon(iconSvg, ".logo-bg{display:none}.logo-bubble{fill:#fff}.logo-dot{fill:#000}");
	const layerArt = Math.round(layer * ADAPTIVE_ART_SHARE);
	return [
		{ file: background, width: layer, height: layer, background: colors.primary, logo: { svg: backgroundLayer, size: layer } },
		{ file: foreground, width: layer, height: layer, background: null, logo: { svg: art, size: layerArt } },
		{ file: `${mipmap}/ic_launcher_monochrome.png`, width: layer, height: layer, background: null, logo: { svg: mono, size: layerArt, mono: true } },
	];
}

/**
 * Files of the Capacitor templates the generated ones replace (the old
 * launch images, stretched to the screen, and the template's icon layers),
 * and the themed icon layer when the icon has none. Removed when present, so
 * the project never ships both.
 */
export function replacedTemplateFiles(brand: NativeBrand): string[] {
	const monochrome = hasMonochromeLayer(brand) ? [] : ANDROID_DENSITIES.map(({ name }) => `${ANDROID_RES}/mipmap-${name}/ic_launcher_monochrome.png`);
	const splashDirs = ["drawable", ...ANDROID_DENSITIES.flatMap(({ name }) => [`drawable-port-${name}`, `drawable-land-${name}`])];
	return [
		...splashDirs.map((dir) => `${ANDROID_RES}/${dir}/splash.png`),
		`${ANDROID_RES}/drawable/ic_launcher_background.xml`,
		`${ANDROID_RES}/drawable-v24/ic_launcher_foreground.xml`,
		`${ANDROID_RES}/values/ic_launcher_background.xml`,
		`${IOS_SPLASH_DIR}/splash-2732x2732-1.png`,
		`${IOS_SPLASH_DIR}/splash-2732x2732-2.png`,
		...monochrome,
	];
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char);
}

const dataUrl = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

/** The Inter faces the web app ships, inlined, so the feature graphic draws Vietnamese text in the app's font. */
function interFontFaces(): string {
	const require = createRequire(import.meta.url);
	return (["latin", "latin-ext", "vietnamese"] as const)
		.map((subset) => {
			const file = require.resolve(`@fontsource/inter/files/inter-${subset}-700-normal.woff2`);
			const data = readFileSync(file).toString("base64");
			return `@font-face{font-family:BrandInter;font-weight:700;src:url(data:font/woff2;base64,${data}) format("woff2")}`;
		})
		.join("");
}

/** 1024 × 500, opaque: the icon, name and description on the brand's dark background. */
export function featureGraphic(brand: NativeBrand, file: string): NativePicture {
	const { width, height } = FEATURE_GRAPHIC;
	const html = `<html><head><style>${interFontFaces()}
html,body{margin:0;width:${width}px;height:${height}px;background:${brand.colors.backgroundDark}}
.frame{display:flex;align-items:center;justify-content:center;gap:56px;width:${width}px;height:${height}px;box-sizing:border-box;padding:0 72px;
background:radial-gradient(circle at 28% 50%, ${brand.colors.primary}66, transparent 62%)}
img{width:220px;height:220px;flex:none}
.text{display:flex;flex-direction:column;gap:16px;color:#fff;font-family:BrandInter,system-ui,sans-serif;font-weight:700}
.name{font-size:120px;line-height:1;letter-spacing:-3px}
.tagline{font-size:34px;line-height:1.25;opacity:.82;max-width:560px}
</style></head><body><div class="frame"><img id="l" alt="" src="${dataUrl(brand.iconSvg)}"><div class="text"><span class="name">${escapeHtml(brand.appName)}</span><span class="tagline">${escapeHtml(brand.description)}</span></div></div></body></html>`;
	return { file, width, height, background: brand.colors.backgroundDark, html };
}

function pictureHtml(picture: NativePicture): string {
	if (picture.html !== undefined) return picture.html;
	const { width, height, background, logo } = picture;
	const page = `html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:${background ?? "transparent"}}`;
	if (logo === undefined) return `<html><head><style>${page}</style></head><body></body></html>`;
	const box = `position:absolute;left:${(width - logo.size) / 2}px;top:${(height - logo.size) / 2}px;width:${logo.size}px;height:${logo.size}px`;
	const url = dataUrl(logo.svg);
	// A luminance mask over white: light parts of the logo stay, dark and empty parts become transparent.
	const element = logo.mono
		? `<div id="l" style="${box};background:#fff;mask-image:url('${url}');mask-size:100% 100%;mask-mode:luminance"></div>`
		: `<img id="l" alt="" style="${box};display:block${logo.round === true ? ";border-radius:50%" : ""}" src="${url}">`;
	return `<html><head><style>${page}</style></head><body><img id="preload" alt="" hidden src="${url}">${element}</body></html>`;
}

/** The part of Playwright's Page the renderer uses. */
export interface PicturePage {
	setViewportSize(size: { width: number; height: number }): Promise<void>;
	setContent(html: string): Promise<void>;
	evaluate(expression: string): Promise<unknown>;
	screenshot(options: { omitBackground: boolean; clip: { x: number; y: number; width: number; height: number } }): Promise<Uint8Array>;
}

/** The part of Playwright's `chromium` the renderer uses. */
export interface PictureLauncher {
	launch(): Promise<{ newPage(options: { deviceScaleFactor: number }): Promise<PicturePage>; close(): Promise<void> }>;
}

/** Waits for fonts and every image of the page, and fails on one that did not decode (a broken SVG). */
const READY = `Promise.all([document.fonts.ready, ...[...document.images].map((img) => img.decode())])
	.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
	.then(() => [...document.images].every((img) => img.naturalWidth > 0))`;

/** Draws the pictures in one Chromium page; returns their PNG bytes in order. */
export async function drawPictures(chromium: PictureLauncher, pictures: readonly NativePicture[]): Promise<Uint8Array[]> {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage({ deviceScaleFactor: 1 });
		const out: Uint8Array[] = [];
		for (const picture of pictures) {
			await page.setViewportSize({ width: picture.width, height: picture.height });
			await page.setContent(pictureHtml(picture));
			if ((await page.evaluate(READY)) !== true) throw new Error(`brand native: ${picture.file} did not render (invalid SVG?)`);
			const png = await page.screenshot({
				omitBackground: picture.background === null,
				clip: { x: 0, y: 0, width: picture.width, height: picture.height },
			});
			const info = pngInfo(png);
			if (info.width !== picture.width || info.height !== picture.height) {
				throw new Error(`brand native: ${picture.file} came out ${info.width}×${info.height}, expected ${picture.width}×${picture.height}`);
			}
			// Store icons and launch images must be opaque; App Store Connect rejects an icon with alpha.
			if (picture.background !== null && info.alpha) throw new Error(`brand native: ${picture.file} has an alpha channel`);
			out.push(png);
		}
		return out;
	} finally {
		await browser.close();
	}
}

/** Size and whether the PNG has an alpha channel (colour type 4 or 6), from its IHDR chunk. */
export function pngInfo(png: Uint8Array): { width: number; height: number; alpha: boolean } {
	const bytes = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
	const signature = "89504e470d0a1a0a";
	if (bytes.length < 29 || bytes.subarray(0, 8).toString("hex") !== signature || bytes.subarray(12, 16).toString("latin1") !== "IHDR") {
		throw new Error("not a PNG file");
	}
	const colorType = bytes[25] ?? 0;
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), alpha: colorType === 4 || colorType === 6 };
}

export interface WriteNativeBrandOptions {
	readonly brand: NativeBrand;
	/** apps/mobile */
	readonly mobileDir: string;
	/** Where the Play feature graphic goes. */
	readonly featureGraphicFile: string;
	readonly chromium: PictureLauncher;
}

function writeFile(file: string, content: string | Uint8Array): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
}

/**
 * Draws everything in memory first (a failing render leaves the projects as
 * they were), then writes the iOS files when apps/mobile/ios exists and the
 * Android files when apps/mobile/android exists, and always the Play art.
 * Returns the written and removed paths, relative to `mobileDir`.
 */
export async function writeNativeBrandFiles(options: WriteNativeBrandOptions): Promise<{ written: string[]; removed: string[] }> {
	const { brand, mobileDir } = options;
	const hasPlatform = (file: string) =>
		(file.startsWith("ios/") && existsSync(join(mobileDir, "ios"))) || (file.startsWith("android/") && existsSync(join(mobileDir, "android")));
	const pictures = nativePictures(brand).filter((picture) => hasPlatform(picture.file));
	const graphic = featureGraphic(brand, options.featureGraphicFile);
	const pngs = await drawPictures(options.chromium, [...pictures, graphic]);

	const written: string[] = [];
	pictures.forEach((picture, index) => {
		const png = pngs[index];
		if (png === undefined) throw new Error(`brand native: no image for ${picture.file}`);
		writeFile(join(mobileDir, picture.file), png);
		written.push(picture.file);
	});
	const graphicPng = pngs[pictures.length];
	if (graphicPng === undefined) throw new Error("brand native: no feature graphic");
	writeFile(graphic.file, graphicPng);
	written.push(relative(mobileDir, graphic.file));
	for (const [file, content] of Object.entries(nativeTextFiles(brand))) {
		if (!hasPlatform(file)) continue;
		writeFile(join(mobileDir, file), content);
		written.push(file);
	}

	const removed: string[] = [];
	for (const file of replacedTemplateFiles(brand)) {
		const full = join(mobileDir, file);
		if (!existsSync(full)) continue;
		rmSync(full);
		removed.push(file);
	}
	// A density directory left empty by the removal (drawable-port-hdpi, …) goes too.
	const res = join(mobileDir, ANDROID_RES);
	if (existsSync(res)) {
		for (const dir of readdirSync(res)) {
			if (/^drawable-(port|land)-/.test(dir) && readdirSync(join(res, dir)).length === 0) rmSync(join(res, dir), { recursive: true });
		}
	}
	return { written, removed };
}
