// Brand assets of the web app, all derived from brand.config.json and the
// brand SVGs, so a rebrand is "edit the brand files, pnpm brand:gen, rebuild":
//
// - index.html: %APP_NAME%, %APP_DESCRIPTION% and %APP_LOGO% (the splash logo:
//   inline SVG for a vector icon, an <img> of /icon.svg for a raster one), plus the favicon, Apple touch icon and manifest links;
// - the icon files (brand/generated/icons/, made by pnpm brand:gen) and
//   manifest.webmanifest at the site root, served in dev and emitted in builds;
// - virtual:brand-logo, what the in-app logo and loaders render (the same
//   choice: inline SVG markup or the icon file's URL, brand-logo-svg.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_FAVICON_SVG, FAVICON_ICO, RASTER_ICONS, generateManifests, webIconFiles } from "@shared-next/brand/build";
import type { Plugin } from "vite";
import { BRAND_ROOT, GENERATED_DIR, MANIFEST_OPTIONS, loadChatBrand } from "./brand-files.ts";
import { brandLogoSource, inlineLogoSvg, splashLogoHtml } from "./src/brand-logo-svg.ts";

const LOGO_MODULE = "virtual:brand-logo";
const RESOLVED_LOGO_MODULE = `\0${LOGO_MODULE}`;
const MANIFEST_PATH = "manifest.webmanifest";

const HTML_ESCAPES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
};

function escapeHtml(value: string): string {
	return value.replace(/[&<>"]/g, (char) => HTML_ESCAPES[char] ?? char);
}

const CONTENT_TYPES: Record<string, string> = {
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".webmanifest": "application/manifest+json",
};

function contentType(path: string): string {
	const extension = path.slice(path.lastIndexOf("."));
	return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

/** The splash logo needs a size before the stylesheet applies (dev loads CSS from JS). */
const SPLASH_LOGO_SIZE = 88;

export function brandAssets(): Plugin {
	const brand = loadChatBrand();
	// webIconFiles serves the brand icon itself at /icon.svg.
	const logo = brandLogoSource(inlineLogoSvg(readFileSync(join(BRAND_ROOT, brand.icon), "utf8")), `/${DEFAULT_FAVICON_SVG}`);
	const splashLogo = splashLogoHtml(logo, SPLASH_LOGO_SIZE);
	const manifest = `${JSON.stringify(generateManifests(brand, MANIFEST_OPTIONS)["web.webmanifest.json"])}\n`;
	/** URL path (no leading slash) to file contents, read on use so pnpm brand:gen shows up without a restart. */
	const files = new Map<string, () => Buffer | string>([
		...webIconFiles(brand, { root: BRAND_ROOT, generatedDir: GENERATED_DIR }).map((icon) => [icon.path, () => readFileSync(icon.file)] as const),
		[MANIFEST_PATH, () => manifest],
	]);
	const appleTouch = RASTER_ICONS.find((icon) => icon.file.startsWith("apple-touch-icon"));
	if (appleTouch === undefined) throw new Error("brand: no Apple touch icon in RASTER_ICONS");
	// Browsers with SVG favicons take the SVG; the others fall back to the ICO.
	const links = [
		`<link rel="icon" href="/${FAVICON_ICO}" sizes="16x16 32x32 48x48">`,
		`<link rel="icon" href="/${DEFAULT_FAVICON_SVG}" type="image/svg+xml">`,
		`<link rel="apple-touch-icon" href="/${appleTouch.file}" sizes="${appleTouch.size}x${appleTouch.size}">`,
		`<link rel="manifest" href="/${MANIFEST_PATH}">`,
		// Browser chrome and the iOS home screen name follow the brand (installing: settings "Cài ứng dụng").
		`<meta name="theme-color" content="${escapeHtml(brand.colors.primary)}">`,
		`<meta name="apple-mobile-web-app-title" content="${escapeHtml(brand.shortName)}">`,
	].join("\n");

	return {
		name: "app-brand-assets",
		resolveId(id) {
			return id === LOGO_MODULE ? RESOLVED_LOGO_MODULE : null;
		},
		load(id) {
			return id === RESOLVED_LOGO_MODULE ? `export default ${JSON.stringify(logo)};` : null;
		},
		transformIndexHtml: {
			order: "pre",
			handler(html) {
				// The visual harness and other test pages have no brand placeholders.
				if (!html.includes("%APP_NAME%")) return html;
				return html
					.replaceAll("%APP_NAME%", escapeHtml(brand.appName))
					.replaceAll("%APP_DESCRIPTION%", escapeHtml(brand.description))
					.replaceAll("%APP_LOGO%", splashLogo)
					.replace("</title>", `</title>\n${links}`);
			},
		},
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				const path = req.url?.split("?")[0]?.slice(1) ?? "";
				const read = files.get(path);
				if (read === undefined) {
					next();
					return;
				}
				try {
					res.setHeader("Content-Type", contentType(path));
					res.end(read());
				} catch (err) {
					next(err);
				}
			});
		},
		generateBundle() {
			for (const [fileName, read] of files) {
				this.emitFile({ type: "asset", fileName, source: read() });
			}
		},
	};
}
