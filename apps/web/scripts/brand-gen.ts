/**
 * pnpm brand:gen: validates brand.config.json and writes what the platforms
 * derive from it to brand/generated/ (web manifest, Capacitor
 * config, PNG/ICO icons drawn from the brand SVGs with Playwright's
 * Chromium), the Go server's copy of the names, and the icons and launch
 * screens of the iOS and Android apps plus the Play feature graphic
 * (scripts/brand-native.ts). Run after editing the brand.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromiumRenderer, formatGenerated, writeBrandFiles } from "@achoo254/brand/build";
import { chromium } from "playwright";
import {
	BRAND_ROOT,
	GENERATED_DIR,
	MANIFEST_OPTIONS,
	MOBILE_DIR,
	PLAY_FEATURE_GRAPHIC_FILE,
	SERVER_BRAND_FILE,
	loadChatBrand,
	serverBrandNames,
} from "../brand-files.ts";
import { readMonochromeIcon, writeNativeBrandFiles } from "./brand-native.ts";

const brand = loadChatBrand();
const written = await writeBrandFiles({
	brand,
	root: BRAND_ROOT,
	generatedDir: GENERATED_DIR,
	manifests: MANIFEST_OPTIONS,
	renderer: chromiumRenderer(chromium),
});
console.log(`Wrote ${written.length} files to ${GENERATED_DIR}: ${written.join(", ")}`);

// The Go server embeds the names it shows users (the assistant bot); a Go
// module cannot read files outside itself, so it gets a copy.
writeFileSync(SERVER_BRAND_FILE, formatGenerated(serverBrandNames(brand)));
console.log(`Wrote ${SERVER_BRAND_FILE}`);

const native = await writeNativeBrandFiles({
	brand: {
		appName: brand.appName,
		description: brand.description,
		colors: brand.colors,
		iconSvg: readFileSync(join(BRAND_ROOT, brand.icon), "utf8"),
		maskableSvg: readFileSync(join(BRAND_ROOT, brand.iconMaskable), "utf8"),
		monochromeSvg: readMonochromeIcon(BRAND_ROOT),
	},
	mobileDir: MOBILE_DIR,
	featureGraphicFile: PLAY_FEATURE_GRAPHIC_FILE,
	chromium,
});
console.log(`Wrote ${native.written.length} files under ${MOBILE_DIR}: ${native.written.join(", ")}`);
if (native.removed.length > 0) console.log(`Removed the Capacitor template files they replace: ${native.removed.join(", ")}`);
